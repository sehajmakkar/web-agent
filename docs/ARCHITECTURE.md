# Architecture

## Shape

```
┌──────────────── web/ (Vite + React) ────────────────┐
│ chat view · conversation sidebar · tool-status line  │
│ citations [n] → source links · sends user timezone   │
└───────────────┬──────────────────────────────────────┘
                │ POST /api/chat  (SSE stream back)
┌───────────────▼──────────── src/server (Hono) ───────┐
│ routes: chat, conversations, health                   │
└───────────────┬──────────────────────────────────────┘
                │
┌───────────────▼──────────── src/agent ───────────────┐
│ 1. clock.now() + user tz                             │
│ 2. temporal.resolve(userText) → date windows         │
│ 3. memory.retrieve(windows, text) → turn context     │  ← SQLite, ~ms, no LLM
│ 4. assemble request (cached prefix + dynamic tail)   │
│ 5. loop: stream → tool_use → parallel exec → repeat  │
│ 6. persist message + sources (sync)                  │
│ 7. enqueue extraction (async, small model)           │
└──────┬───────────────────────┬───────────────────────┘
       │                       │
┌──────▼───── src/tools ─┐  ┌──▼────── src/memory ─────────────┐
│ web_search             │  │ store · retrieve · extract       │
│  → search/provider.ts  │  │ temporal (date resolver)         │
│    tavily | exa        │  └──┬───────────────────────────────┘
│  → cache (TTL)         │     │
│ recall (internal)      │  ┌──▼────── SQLite (better-sqlite3) ─┐
└────────────────────────┘  │ conversations · messages(+FTS5)   │
                            │ sources · claims · notes          │
                            └───────────────────────────────────┘
```

`src/agent` talks to the model only through `src/llm/ModelClient` (Gemini adapter now under the availability constraint [C-0], Anthropic adapter preferred).
The agent core (`src/agent`, `src/memory`, `src/tools`) has **no HTTP, UI or provider-SDK dependency**. The
server, the eval runner and a debug CLI all call the same `runTurn()` function.

## One turn, step by step

Worked example. Now = **Wed 11 Nov 2026, 10:00 Europe/London**.
User: *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*

1. **Clock.** `clock.now()` returns real time, or `AGENT_NOW` in tests and demos. The timezone comes from the browser (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
2. **Temporal resolver** (chrono-node plus our own weekday rules):
   `"last Tuesday" → candidates [Tue 10 Nov, Tue 3 Nov], ambiguous=true`; `"since then" → anchor = resolved date`.
3. **Memory retrieval** (pure SQL, no model call):
   - *Index*: the last ~30 days of conversations as one line each: `date · weekday · title · topics` (~300 tokens).
   - *Window hits*: conversations whose local date falls in a candidate window, ranked by FTS5 match on "Postgres hosting". Result: only 3 Nov matches, so the ambiguity resolves itself.
   - *Evidence*: claims and sources attached to that conversation:
     `Neon · Launch · $19/mo · neon.com/pricing · observed 3 Nov`, `Supabase · Pro · $25/mo · ...`.
4. **Assemble the request.**
   `tools + static system prompt` → conversation history → user message + **turn context**
   (now, resolved dates, memory digest, memory coverage). Dynamic content goes *last*, so the date never breaks the prompt cache.
   On Gemini [C-0] the turn context is a tagged `<turn_context>` block on the current user turn, not saved to history. On Claude it would be a mid-conversation system message (ADR-010).
5. **Agent loop** (streaming):
   - The model calls `web_search({ queries: [...], urls: ["neon.com/pricing", ...], since: "2026-11-03" })`.
     Queries run **in parallel**. Previously cited URLs are re-read live. Results are numbered `[1]..[n]` and wrapped as untrusted data.
   - Text streams to the UI as SSE. Tool activity streams as status events ("Re-checking neon.com/pricing…").
   - Guard rails: at most N loop iterations and a wall-clock budget. When a budget runs out, the model answers with what it has and says what it couldn't check.
6. **Persist (sync).** Save the assistant message, the sources (url, title, fetched_at, content hash, excerpt) and the validated citations. Citation numbers that don't exist are stripped.
7. **Extract (async).** A small model with structured output produces the title, topics, claims `{entity, attribute, value, source_id, quote}`, and notes `{kind: decision|preference|shortlist, items}`. This runs off the critical path. The next turn's retrieval waits for pending extraction for at most ~1s, then falls back to raw messages.

The answer the user sees: "On **Tue 3 Nov** you asked about Postgres hosting. Here's what changed since:"
followed by a table (*Then (3 Nov)* | *Now* | *Changed?* | *Source*) and a clear split between
*changed*, *verified unchanged* and *couldn't verify*.

## Data model (SQLite)

```sql
conversations(id, started_at_utc, tz, local_date, title, summary, topics_json)
messages(id, conversation_id, role, content, created_at_utc, local_date)   -- + messages_fts (FTS5)
sources(id, url, title, fetched_at_utc, content_hash, excerpt, published_at)
message_sources(message_id, source_id, citation_index)
claims(id, message_id, entity, attribute, value, unit, source_id, quote, observed_at_utc,
       supersedes_claim_id)                                                -- the evidence ledger
notes(id, conversation_id, kind, payload_json, created_at_utc)              -- decisions, shortlists, prefs
```

There is one user, so no auth. The schema keeps a `user_id`-shaped seam for later.

## Memory layers

| Layer | What | Why it exists | Example question it serves |
|---|---|---|---|
| Working | current conversation messages | normal follow-ups | "and the second one?" |
| Episodic | every message, timestamped, FTS-indexed | "what did I ask on X" | example 2 |
| Evidence ledger | claims + sources + observed_at | "has it changed since" | example 3 |
| Notes | user decisions, shortlists, preferences | "the 5 we shortlisted" | example 1 |
| Index | one-line per conversation, always injected | lets the model notice relevant history without a tool call | all |

## Tools the model sees

- `web_search({ queries: string[1..6], since?: ISODate, urls?: string[], depth?: "fast"|"thorough" })`.
  **The only tool.** Batched queries mean one tool call fans out in parallel. `urls` re-reads known pages (for example a pricing page we cited before). `since` maps to the provider's published-date filter.
- Memory is **not** a tool (ADR-005, option A). It always arrives as turn context. A `recall` tool is the fallback (option B) if the eval shows retrieval misses.

## Latency plan

| Lever | Effect |
|---|---|
| Stream text and tool-status events | perceived latency ≈ TTFT |
| Retrieval before the model runs, in SQL | memory costs ~ms, not an extra LLM round trip |
| Batched, parallel search queries | 5 entities × 2 queries ≈ the latency of 1 query |
| Search provider returns page content | no separate fetch hop per result |
| Prompt caching (static prefix) | lower TTFT on every turn |
| Search result cache (short TTL) | repeated queries in eval and demo are instant |
| Model is told to skip search for stable or chit-chat turns | the fastest search is the one you don't do |
| Thinking level (Gemini) / effort + fast mode (Claude) as config knobs | tuned by eval, not by guess |
| Small model for extraction, off the critical path | user never waits for bookkeeping |
