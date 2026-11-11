# Build plan: iterative, thin vertical slices

Each phase ends with something that runs end to end and a clear exit check.
The rule throughout: **no phase adds a feature without an eval scenario for it.**

---

## Phase 0 · Understand and spike (~2h). ✅ **Done 2026-11-11** (report: `spikes/phase0/README.md`)
- ✅ Broke the three examples into required capabilities (THINKING.md §1).
- ✅ [C-0] Listed 50 Gemini models and probed 6 Flash / Flash-Lite models. **Chose `gemini-3.5-flash` (chat) + `gemini-3.5-flash-lite` (extraction)** with a fallback chain. 3.8 Flash was ruled out by its 20 requests/day free-tier cap and 503s (ADR-017).
- ✅ Search spike on 15 queries × 4 configs. **Exa `fast` primary (0.7s p50, primary source in top 3 for 13/14), Tavily fallback** (ADR-004).
- ✅ Wrote 10 eval scenarios plus seed fixtures before the code (`evals/`).
- Findings that changed the design: the model doesn't fill `since` (→ ADR-018), it resolves "Monday" to the future (→ backs up ADR-008), Gemini SSE uses CRLF framing and requires `thoughtSignature` round-tripping (→ adapter notes), and latency varies 1.6–10.7s (→ C20).
- **Exit:** ✅ provider chosen, ✅ models chosen, ✅ scenarios written.

## Phase 1 · Walking skeleton: chat + search + streaming (~3h)
- `npm run dev` → Hono server + Vite UI. `.env.example`.
- `ModelClient` interface + Gemini adapter (`@google/genai`).
- `runTurn()` agent loop against `ModelClient`: streaming, `web_search` tool with batched parallel queries, iteration and time caps.
- Numbered sources, `[n]` citations rendered as links, tool-status line in the UI.
- Today's date in the turn context (via `clock.ts` from day one).
- **Exit:** "What changed in the latest Node.js release?" gives a cited, current answer. Logs show TTFT and total time.

## Phase 2 · Persistence + clock (~2h)
- SQLite schema and migrations. Conversations and messages saved. Sidebar with past chats, "new chat".
- Browser timezone captured. `AGENT_NOW` override. Separate DB path for the demo and eval.
- `npm run seed:demo`: backdated conversations (Tue 3 Nov Postgres hosting with real cited prices; Mon 9 Nov CRM shortlist of 5; Tue 10 Nov something unrelated).
- **Exit:** restart the server and history survives. The seeded conversations show under the right dates.

## Phase 3 · Temporal memory (~3h)
- `temporal.resolve()` with unit tests (weekday ambiguity, "3 November", "since then", "yesterday", tz edges).
- `memory.retrieve()`: index, window hits and FTS. Injected as the turn-context system message.
- Coverage statement plus the never-invent rule. Cold-start behavior.
- `recall` tool for drill-down.
- **Exit:** example 2 passes warm *and* cold. "Last Tuesday" ambiguity resolved by topic in the eval.

## Phase 4 · Evidence ledger + re-verification (~4h)
- Persist sources with excerpt and hash. Async extraction (small model, structured output) → title, topics, claims, notes.
- Re-verification prompt policy: re-read cited URLs, date-bounded search, a changed / unchanged / couldn't-verify table.
- **Exit:** examples 1 and 3 pass on seeded data. Answers name the date, the old value, the new value and both sources.

## Phase 5 · Speed + quality pass, driven by evals (~3h)
- Eval runner (`npm run eval`): scenarios, deterministic checks, LLM judge, latency, search count and cost per scenario.
- Prompt caching verified. Search cache. Thinking-level and model sweep across the available Gemini models (and Claude Opus 5.5 / Sonnet 5.5 once a key exists).
- Tune the search-or-not policy, source-quality guidance and answer style (concise, tables for comparisons).
- Prompt-injection and provider-failure scenarios.
- **Exit:** a scorecard in `evals/RESULTS.md` with before and after numbers for each change.

## Phase 6 · Polish + write-up (~2h)
- UI: markdown and tables, source hover cards, error states, "stop" button.
- README: setup, keys, `seed:demo`, `AGENT_NOW`, a "try these prompts" list for the reviewers.
- **DESIGN.md** (one page, written last from the real system): how it works, why, what was rejected, next week.
- **Exit:** a fresh clone, then `npm install && npm run dev`, works with only the keys in `.env.example`.

---

## With another week
- Anthropic adapter (`src/llm/anthropic.ts`) and a head-to-head eval against Gemini (lifting constraint C-0).
- Embeddings over messages and claims for paraphrase recall (sqlite-vec).
- Proactive watch: "tell me if any of these 5 change pricing". A scheduled re-check of the stored claims.
- A deterministic fast path for the re-verify intent: fan out the URL re-reads *before* the first model call, so it's one LLM pass.
- Page-diff store: a full text snapshot per source, with a semantic diff ("Pro plan went from 5 to 3 seats").
- User profile memory ("20-person sales team", preferred region or currency) that personalizes answers.
- Recorded and replayed search fixtures for a fully offline CI eval.
