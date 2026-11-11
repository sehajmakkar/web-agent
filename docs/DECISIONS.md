# Decisions (ADR log)

Format: **Decision**, **Considered**, **Why**, **Revisit if**. New decisions get appended. Superseded ones stay, marked as such.

---

### ADR-001 · TypeScript on Node 20+, ESM, `tsx` for dev
- **Considered:** plain JS; Bun/Deno (rejected: the rules say Node).
- **Why:** types catch tool-schema and DB-row mistakes, and the shared types between server and UI are worth it. `tsx` runs TS with no build step, so `npm run dev` stays one command.
- **Revisit if:** never, for this project.

> **Constraint C-0 (availability):** for now the only LLM key available is **Google Gemini**. No Anthropic or OpenAI API key.
> The design below targets Claude as the *preferred* model (ADR-003). The build runs on Gemini (ADR-017), behind a narrow
> model interface, so switching to Claude means writing one adapter file and changing one env var. Every place where
> Gemini changes a decision is marked **[C-0]**.

### ADR-002 · No agent framework: own the loop on the provider's official SDK (`@google/genai` now [C-0], `@anthropic-ai/sdk` preferred)
- **Considered:**
  - *LangChain / LangGraph*: rejected. It hides the prompt and the loop behind abstractions. Its memory primitives (buffer/summary/vector) have no notion of time. Debugging means reading framework internals. The reviewers judge architecture, and a framework would *be* the architecture.
  - *Vercel AI SDK*: the strongest alternative, with good streaming and `useChat`. **Reconsidered under [C-0]**, because provider switching is now a real need, and that is exactly what it's for. Still rejected: what we need from a model is narrow (stream text, emit tool calls, report usage), so our own `ModelClient` interface is about 100 lines per adapter. Our loop, context assembly and event stream stay provider-free. The provider-neutral layer would also flatten features we'd use per provider (Claude: mid-conversation system messages, cache breakpoints, effort, refusal fallbacks; Gemini: thinking config, implicit caching). Acceptable alternative if time gets tight.
  - *Mastra*: has memory built in, but it is semantic recall, not time-aware. Same abstraction cost.
  - *Claude Agent SDK*: a coding-agent harness with filesystem tools. Wrong shape, and its built-in WebSearch isn't controllable.
  - *Anthropic Tool Runner (SDK beta helper)*: close. Rejected because we need custom per-iteration behavior: streaming status events, a wall-clock budget, evidence capture, citation renumbering.
- **Why:** the loop is about 150 lines. Owning it means every token the model sees is assembled in one place (`src/agent/context.ts`) and can be explained.
- **Revisit if:** we add multiple providers or complex multi-agent flows.

### ADR-003 · Preferred model: Claude Opus 5.5 for the conversation; small model for background extraction. **Blocked by [C-0], see ADR-017**
- **Considered:** Claude Sonnet 5.5 (faster, cheaper); Fable 5.2 (most capable, slower, pricier); GPT/Gemini (no reason to mix providers).
- **Why:** answer quality on multi-step research is the main differentiator. Opus 5.5 at a tuned `effort` (default `medium`, try `low` for chit-chat) balances that with speed. Background extraction (title, topics, claims) is structured and simple, so it uses `claude-haiku-5-5` with structured outputs.
- **Notes:** thinking can't be disabled on Opus 5.5; effort is the control. Forced `tool_choice` is a 400, so we use `auto` plus prompting. Server-side `fallbacks: "default"` handles refusals. `speed: "fast"` is a latency knob worth measuring.
- **Config:** `MODEL`, `EXTRACT_MODEL`, `EFFORT` env vars, so we can switch the model based on eval results.
- **Revisit if:** the eval shows Sonnet 5.5 matches quality at noticeably lower latency.

### ADR-004 · Own `web_search` tool behind a provider interface (Tavily first, Exa as candidate)
- **Considered:**
  - *Anthropic server-side `web_search_20260209`*: zero plumbing, fast, citations included. Rejected as the primary because there is no published-date filter (we need "since Monday"). We can't snapshot page content into our evidence ledger, can't cache, and can't swap providers.
  - *Gemini built-in Google Search grounding* [C-0]: same trade-off as Anthropic's server tool (no date filter, no page content to snapshot, no cache). Also, depending on the model version, built-in grounding may be restricted when combined with custom function calling. Rejected for the same reasons.
  - *Brave / Serper / SerpAPI*: snippets only, so each result needs a second fetch. Slower.
  - *Tavily*: built for agents. Returns cleaned content, has a date/time range filter and an extract endpoint for known URLs. One key.
  - *Exa*: strong semantic search, published-date filters, live-crawl option for freshness.
- **Why:** owning retrieval gives us date-bounded search, re-reading known URLs, raw evidence to store and diff, caching, and a clean seam for evals.
- **Result of the Phase 0 spike (2026-11-11, `spikes/phase0/README.md`):** **Exa primary, Tavily fallback.** Over 15 test-shaped queries, Exa `fast` had p50 latency of 0.7s (Tavily basic: 1.9s), put the primary source in the top 3 for 13/14 queries (Tavily: 10/14), returned published dates on about half its results (Tavily: 0 outside news mode), and had 0 results before the `since` date.
  Usage: `type: "fast"` by default, `"auto"` for `depth: "thorough"`, `startPublishedDate` for `since`, `/contents` with livecrawl to re-read cited URLs. Tavily `/search` and `/extract` sit behind the same interface and run when Exa errors or times out.
- **Revisit if:** the provider's date filters prove unreliable. Then fall back to query rewriting plus post-filtering on `published_at`.

### ADR-005 · How we read the "one tool: web search" rule. **Decided: A (strict), 2026-11-11**
- **Options:**
  - *A. Strict: the model sees exactly one tool, `web_search`.* Memory is never a tool. Code retrieves it before every turn and injects it as context.
  - *B. Loose: `web_search` plus an internal read-only `recall` tool* for digging into history the injection missed.
- **Recommendation: A.** It complies with the rule literally, so no reviewer can mark us down for it. It's faster (no extra round trip) and more reliable (the model never has to *decide* to remember). The example prompts are anchored by date and topic, which deterministic retrieval handles. Framing: *"Memory isn't a tool the agent chooses to use; it's context the agent always has."*
- **Cost of A:** open-ended history questions ("everything we discussed in October") rely on retrieval guessing well. Mitigation: retrieval widens the window when the resolver finds a broad range. If the eval shows misses, B is a small, isolated change.

### ADR-006 · SQLite (`better-sqlite3`) + FTS5; no vector DB yet
- **Considered:** Postgres + pgvector (needs a running server, which breaks `npm install && npm run dev`); JSON files (no querying); `node:sqlite` (needs Node 22.5+); embeddings + sqlite-vec.
- **Why:** zero setup, synchronous, fast. The test questions are anchored by **date** and **named topic**, and date range + BM25 handles those. For paraphrase ("database hosting" vs "Postgres"), the extracted `topics` (generated by the small model at write time) do the work without an embeddings API key.
- **Revisit if:** the eval shows recall misses on paraphrased references. Then add embeddings (another week).

### ADR-007 · Memory = episodic log + evidence ledger + notes
- **Why:** "has it changed?" needs *what we observed, from where, when*, not just what we said. Claims carry `source_id`, `quote`, `observed_at` and `supersedes_claim_id`, so re-verification is a diff and history is kept.
- **Considered:** transcript-only memory (the model re-reads its own prose; fragile, can't tell "I claimed" from "I verified"); ChatGPT-style free-text memories (no provenance).

### ADR-008 · Temporal reasoning in code, not in the model
- **Why:** relative dates are deterministic given `now` and a timezone, and the model is unreliable at weekday arithmetic. **Phase 0 evidence:** given "today is Wed 11 Nov", every Gemini Flash model resolved "on Monday" to the *next* Monday (16 Nov), where our test case means 9 Nov. The resolver returns windows plus ambiguity flags. The model decides what to *do* about ambiguity (usually: let memory disambiguate, state the assumption, never silently pick).
- **As built (Phase 3): our own resolver, no date library** (`src/memory/temporal.ts`, ~200 lines, 25 tests). I considered `chrono-node` and rejected it: its job is to pick *one* date, and ours is to return *all* plausible ones with an ambiguity flag. Its default weekday semantics are the very thing under test, and the rules ("last Tuesday" is ambiguous only when the most recent one is in the current ISO week; bare weekdays are past; day+month without a year is the most recent past occurrence) need to be visible and explainable. Timezones go through `Intl` (no `date-fns-tz`). Scope: English only.

### ADR-009 · Injectable clock + seed fixtures
- **Why:** reproducible evals and demos. `AGENT_NOW=2026-11-11T10:00` freezes time. `npm run seed:demo` loads backdated conversations (3 Nov Postgres hosting, 9 Nov CRM shortlist) into a separate DB file, so the reviewers' real usage is never polluted.
- **Rule:** nothing calls `Date.now()` / `new Date()` directly. Everything goes through `src/lib/clock.ts`.
- **As built (Phase 2):** `AGENT_NOW` *anchors* the clock and time keeps ticking from there, so message ordering still works in a time-travelled demo. `npm run demo` = reseed `data/demo.db` plus clock anchored at 2026-11-11T10:00Z plus its own ports (5180/8790), so it never touches `data/agent.db` and can run beside `npm run dev`.
- **Considered:** shifting fixture dates to be relative to the real "now" (so no clock override is needed). Rejected: it breaks absolute-date prompts like "What did I ask you on 3 November?", which is the reviewers' own example, and whole-week shifting gets odd on Mondays and Tuesdays. Anchoring makes their prompts work word for word.

### ADR-010 · Context assembly for prompt caching
- **Principle (provider-independent):** `tools + static system prompt + history` is a stable prefix. Per-turn facts (now, resolved dates, memory digest) come **last**. Putting `now` in the system prompt would break caching on every turn.
- **On Gemini [C-0]:** there are no mid-conversation system messages. The turn context is a clearly tagged `<turn_context>` block attached to the *current* user turn and not saved into stored history, so the prefix stays byte-stable for Gemini's prefix caching (verify cache-hit tokens in usage metadata during Phase 5).
- **On Claude (preferred):** a mid-conversation system message after the user message, the operator channel, kept separate from user text.

### ADR-017 · Run on Gemini via `@google/genai` behind a `ModelClient` interface [C-0]
- **Decision:** `src/llm/ModelClient.ts` defines `stream(request) → AsyncIterable<TextDelta | ToolCall | Usage | Done>`. `src/llm/gemini.ts` implements it now. `src/llm/anthropic.ts` is the planned drop-in. The agent loop, context assembly, tools and memory never import a provider SDK.
- **Models (chosen in Phase 0, `spikes/phase0/README.md`):**
  - **Update 2026-11-12: both roles use `gemini-3.5-flash-lite`.** Development runs on free-tier keys, and Flash-Lite is the cheapest model with acceptable tool calls (Phase 0: same batching behavior as Flash, valid JSON). `gemini-3.5-flash` is the first upgrade to evaluate in Phase 5.
  - Overload policy: on **503 / timeout**, try `GEMINI_FALLBACK_MODELS` (default `gemini-3.1-flash-lite`). On **429 quota**, don't switch models silently. Surface a clear "quota exceeded, rotate `GEMINI_API_KEY`" error. The app doesn't pool or rotate keys automatically (that's an operator decision and could break provider terms).
  - Rejected for now: `gemini-3.8-flash` (newest, but **20 requests/day/model on the free tier** plus 503 "high demand") and `gemini-3.7-flash` (503s, timeouts). Revisit on a paid tier.
  - IDs are overridable via `GEMINI_MODEL` / `GEMINI_EXTRACT_MODEL`.
- **Why the interface instead of Gemini everywhere:** the constraint is temporary, and the reviewers may prefer a different model. The interface also forces us to keep provider quirks out of the core.
- **Gemini-specific notes (verified in Phase 0):** tool calls arrive as `functionCall` parts and results go back as `functionResponse` parts. The model batches several queries into one call. SSE events are framed with **CRLF**, so normalise before splitting. Gemini 3.x parts carry **`thoughtSignature`**, which must be sent back unchanged on later turns. Thinking uses `thinkingConfig.thinkingLevel` (`minimal|low|medium|high`) on 3.x and `thinkingBudget` on 2.5. Latency varies a lot (1.6s to 10.7s for the same request), so streaming status events carry perceived speed.
- **Revisit when:** an Anthropic key is available. Write `anthropic.ts`, run the same eval suite on both, pick on numbers, record the result here.

### ADR-011 · Transport: HTTP + SSE via Hono
- **Considered:** WebSockets (bidirectional, which we don't need); Express (fine, but its streaming ergonomics are worse); raw `node:http` (more boilerplate).
- **Why:** SSE is one-directional server→client, which is exactly what streaming tokens and status events need. Hono is tiny and typed.

### ADR-012 · UI: Vite + React, deliberately minimal
- **Considered:** Next.js (one process, but heavier and it blurs the server/agent boundary); CLI-only (reviewers want to chat "like a real user"); a chat UI kit.
- **Why:** the screen isn't judged. It needs to be pleasant (streaming markdown, citations, tool status, sidebar) and nothing more. `npm run dev` runs the server and Vite with `concurrently`.

### ADR-013 · Extraction runs async after the answer streams
- **Why:** the user should never wait for bookkeeping. The race (an immediate follow-up asking about the last answer) is handled by: raw messages and sources are saved synchronously, and retrieval briefly awaits in-flight extraction.

### ADR-014 · Citations: server-numbered sources, validated before persisting
- **Why:** the model cites `[n]` against sources numbered by our tool. The server drops citations that don't point to a real source, so a link can never point at nothing.

### ADR-015 · Evals are a first-class part of the repo
- **Decision:** `npm run eval` runs scenario files (seeded history, frozen clock, user turns) through `runTurn()`. It scores with deterministic checks plus an LLM-judge rubric and records latency, search count and cost.
- **Why:** "best architecture" claims need evidence. Evals also stop prompt changes from quietly breaking the memory flows.

### ADR-018 · The code owns the `since` date for "changed since" turns
- **Decision:** when the resolver finds a "since X" anchor (or a past-conversation date the user asks about), `runTurn()` sets `since` on every `web_search` call that turn. The model's own `since`, if any, is only a hint. It can't widen the window past the anchor.
- **Why:** in Phase 0 the model batched queries well but never filled `since` (it wrote "November 2026" into the query text). Date-bounded search is central to examples 1 and 3, so it can't depend on the model remembering a parameter.

### ADR-019 · Cold start: be honest, then help with a labelled assumption. **Decided 2026-11-11**
- **Context:** the reviewers' database will be empty, so "On Monday we shortlisted 5 CRMs…" will almost always be asked with no memory to draw on.
- **Options:** (1) only ask for the list: honest but no value this turn; (2) silently guess as if remembered: **invents memory**, so never; (3) state clearly that there's no record, then answer for a **labelled** likely set, inferred from the context in the message ("20-person sales team"), and invite correction.
- **Decision:** option 3 when the request has enough context for a reasonable assumption. When it doesn't ("What did I ask you on 3 November?"), say there's no record, give memory coverage, and offer the next step ("paste it and I'll check it").
- **Rule:** the no-record statement comes first, in plain words. Assumed items are never phrased as recalled.

### ADR-020 · Past turns are replayed as plain text; tool traffic stays inside the turn
- **Decision:** within a turn, the full provider transcript (function calls with their `thoughtSignature`, function responses) goes back to the model. Across turns, history is just `user text` / `assistant final answer` (with its [n] citations). Raw search results are not replayed.
- **Why:** keeps every later turn small and fast, and avoids replaying stale web content as if it were fresh. Signatures only need to round-trip inside the current turn. What a past answer was based on lives in the evidence ledger (Phase 4), which is retrieved deliberately rather than dragged along.
- **Phase 1 state:** the browser holds history and sends it with each turn (stateless server). Phase 2 moves history into SQLite.

### ADR-021 · Perceived latency comes from status events, not model speed
- **Decision:** the loop emits `status` events at each stage ("Searching “…” · reading neon.com", "Reading results…"), and the UI shows them as a live line, plus a sources count as results arrive.
- **Why:** Phase 1 measured the first answer token at ~4s on search turns (the search round trip happens before any text), and Phase 0 measured 1.6–10.7s variance from the model API. Status lines appear within ~1–2s, so the user sees progress immediately.

### ADR-022 · Persistence rules (Phase 2)
- **The server owns history.** The client sends only `conversationId` and the new message. It can't inject or edit past turns, and the agent sees exactly what is stored.
- **The question is saved before the answer is generated.** "What did I ask you on X?" must include questions whose answer failed or was cancelled. Consecutive user turns are merged in `context.ts` so the model still sees alternating turns.
- **Sources are snapshotted per message, not deduplicated across messages.** `sources` keeps what a page said *when we read it* (excerpt + sha256 + fetched_at). That's the "then" side of every later "has it changed?" comparison. All retrieved sources are stored with a `cited` flag; the UI shows only cited ones.
- **`local_date` is computed at write time** in the conversation's timezone, so date lookups are indexed equality, not timezone maths at query time (C5).
- **Excerpts never go over the wire.** SSE and REST send link metadata only; excerpts can be several KB each.

### ADR-023 · Dual retrieval for change windows
- **Problem:** with `since` set, the provider's date filter drops **undated pages, and pricing pages are almost always undated**. A "has pricing changed since X" turn would lose the one page it needs.
- **Decision:** when a window is active, every query runs twice in parallel: date-filtered (4 results: news, changelogs inside the window) and unfiltered (3 results: current pages). Each result is labelled: inside the window, `BEFORE WINDOW … background, not a change`, or `unknown (current page content)`.
- **Cost:** 2× provider calls with no added latency (they run in parallel). This also fixes the Phase 1 leak at the source, since older items are now visibly labelled as background.

### ADR-024 · The answer is the final step's text; pre-search drafts are discarded
- **Problem (Phase 3, live):** the model wrote a full "no change found" table *before* searching, then searched and answered again. The draft's `[1][2][3]` passed citation checking only because sources numbered later happened to match.
- **Decision:** text from a step that ends in a tool call is discarded. The loop emits `reset`, the UI clears it, and the status line takes over. Only the final (tool-free) step's text is saved, citation-checked and shown. The prompt also says "call web_search straight away", so drafts are rare, but correctness doesn't depend on that.

### ADR-025 · Verification checklist and answer shape come from the ledger, in code
- **Problem (Phase 3, live):** given claims in the memory block, Flash-Lite restated the "then" value from *today's* page and so reported "no change" for a real change. With a shortlist (no recorded prices) a forced "Then" column made it invent then-values.
- **Decision:** on change turns the planner renders a numbered `verification_checklist` with the **recorded values verbatim**, plus an `answer_shape` that depends on what was recorded: `Item | Then | Now | Verdict` for claims, and `Item | What's new since <date> | Verdict` for decisions such as shortlists.
- **Why:** the model's job becomes filling in a structure, not designing one. That's reliable even on a small model.

### ADR-026 · The no-record policy is decided in code
- **Problem (Phase 3, live):** cold D2 ("On Monday we shortlisted…") only asked for the list, despite ADR-019 being in the system prompt.
- **Decision:** when the user refers to history and nothing was recalled, the memory block carries an explicit `no_record_policy`. It says **PROCEED** (labelled assumption + search now; the no-record sentence opens the *final* answer) if the message is a change question with a topic. Otherwise it says **offer the next step, don't search or guess**.

### ADR-016 · Single user, no auth
- **Why:** this is the assignment scope. The `user_id` seam stays in the schema.
