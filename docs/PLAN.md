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

## Phase 1 · Walking skeleton: chat + search + streaming (~3h). ✅ **Done 2026-11-12**
**Result:** `npm run dev` serves the UI at :5173 and the API at :8787. `npm run ask -- "…"` runs the same turn headless. 13 unit tests, clean typecheck.
Measured with `gemini-3.5-flash-lite`:

| Turn | Searches / queries | First token | Total | Notes |
|---|---|---|---|---|
| "hey! what's 15% of 240?" | 0 / 0 | 1.4s | 1.4s | no search, correct (eval F1 ✓) |
| "latest Node.js release…" | 1 / 2 | 4.1s | 4.9s | cited nodejs.org release + security posts |
| "HubSpot, Pipedrive or Attio changed pricing since 1 Nov?" | 1 / 3 | 3.6s | 4.7s | primary sources found, **but `since` not set → Sep/Oct items leaked in** (C19, fixed by Phase 3 resolver) |
| "most recent F1 race?" (via HTTP/SSE) | 1 / 3 | 4.6s | 4.6s | streaming SSE through the Vite proxy ✓ |

Learnings: the first answer token only arrives after the search round trip, so **status events carry perceived latency** ("Searching …" shows in about 1–2s). `cachedTokens` stayed 0; check implicit caching in Phase 5.

Planned items:
- `npm run dev` → Hono server + Vite UI. `.env.example`.
- `ModelClient` interface + Gemini adapter (`@google/genai`).
- `runTurn()` agent loop against `ModelClient`: streaming, `web_search` tool with batched parallel queries, iteration and time caps.
- Numbered sources, `[n]` citations rendered as links, tool-status line in the UI.
- Today's date in the turn context (via `clock.ts` from day one).
- **Exit:** "What changed in the latest Node.js release?" gives a cited, current answer. Logs show TTFT and total time.

## Phase 2 · Persistence + clock (~2h). ✅ **Done 2026-11-12**
**Result:** SQLite (`better-sqlite3`, prebuilt, no compile step) with numbered migrations. All 6 tables are created now (claims/notes are filled by seeds; extraction comes in Phase 4). The server owns history: the browser sends only `conversationId`. There's a sidebar grouped by day using the *server* clock, `#c=<id>` deep links, and delete.
`npm run seed:demo` loads the fixtures into `data/demo.db`. `npm run demo` reseeds and starts on **its own ports (5180/8790)** with the clock anchored at Wed 11 Nov 10:00 London, so the assignment's prompts work verbatim and it can run next to `npm run dev`.
Verified: the 4 seeded chats list under 10 Nov / 9 Nov / 3 Nov. A new two-turn chat persisted, and the follow-up ("how much per year?") resolved "that" from the stored history. Timestamps follow the anchored clock. 19 unit tests (+6: store, timezone local dates, FTS sync, seeds, history merge).
Found while testing: a `npm run dev` the user had running held 8787/5173, so the first demo attempt crashed with EADDRINUSE and Vite silently moved to 5174. Fixed with dedicated demo ports and Vite `strictPort` (C21).

Planned items:
- SQLite schema and migrations. Conversations and messages saved. Sidebar with past chats, "new chat".
- Browser timezone captured. `AGENT_NOW` override. Separate DB path for the demo and eval.
- `npm run seed:demo`: backdated conversations (Tue 3 Nov Postgres hosting with real cited prices; Mon 9 Nov CRM shortlist of 5; Tue 10 Nov something unrelated).
- **Exit:** restart the server and history survives. The seeded conversations show under the right dates.

## Phase 3 · Temporal memory (~3h). ✅ **Done 2026-11-12**
**Built:** `memory/temporal.ts` (own resolver, 25 tests), `memory/retrieve.ts` (planner: coverage, index, window recall with topic-based disambiguation, FTS fallback, verification checklist, no-record policy, code-owned `since`), dual retrieval in `web_search`, draft discarding in the loop, a memory trace on every `done` event. 58 unit tests.

Live results on `gemini-3.5-flash-lite` (demo clock Wed 11 Nov 10:00 London):

| Scenario | Result | Time |
|---|---|---|
| A1 "What did I ask on 3 Nov? Still correct?" (warm) | ✅ both 3 Nov questions, re-read the 3 cited URLs, per-item verdicts | 7.5s |
| B1 "Last Tuesday … Postgres hosting" (warm) | ✅ resolved to **3 Nov** by topic (10 Nov = Lisbon), states the date, verbatim then-values, **Neon flagged changed** | 4.8s |
| C1 "On Monday we shortlisted 5 CRMs…" (warm) | ✅ exact recorded shortlist (Attio, not Salesforce), 5 parallel queries since 9 Nov, per-tool verdict | 6.4–7.5s |
| D1 cold "What did I ask on 3 Nov?" | ✅ "no record of Tue 3 Nov; history starts today" + next step, no search | 1.3s |
| D2 cold CRM | ✅ no-record first, labelled assumed five, searched, invites correction | 5.4s |
| D3 cold Postgres | ✅ same pattern; found Neon's 6 Nov changelog (primary) | 4.9s |
| F1 no-search, warm DB | ✅ no search | 1.7s |

**Iterations it took** (each one a live failure, then a structural fix rather than a prompt nudge):
1. The model wrote an unverified draft table *before* searching, with citation numbers that only matched by luck → **only the final step's text is the answer**, plus a `reset` event (ADR-024).
2. It rewrote the recorded "then" value from today's page and so missed Neon's change → **verification checklist with verbatim recorded values** (ADR-025).
3. A forced "Then" column on a shortlist (no prices recorded) made it invent then-values → **answer shape depends on what was recorded**.
4. Cold D2 only asked for the list despite the prompt rule → **no-record policy decided in code** (ADR-026). Then the no-record sentence got discarded with the pre-search draft → the policy now says it belongs in the *final* answer.
5. SQLite: `bm25()` can't run inside an aggregate and plain subqueries get flattened → `MATERIALIZED` CTE.
6. `seed:demo` deleted the DB file under a running demo server → reseed in place (C22).

Known model-quality gaps (logged, not hidden): Flash-Lite missed "per project → per organization" as a change, and once reported a 4 Nov/8 Nov event as "since 9 Nov" because the article was published on 9 Nov (C23).

Planned items:
- `temporal.resolve()` with unit tests (weekday ambiguity, "3 November", "since then", "yesterday", tz edges).
- `memory.retrieve()`: index, window hits and FTS. Injected as the turn-context system message.
- Coverage statement plus the never-invent rule. Cold-start behavior.
- `recall` tool for drill-down.
- **Exit:** example 2 passes warm *and* cold. "Last Tuesday" ambiguity resolved by topic in the eval.

## Phase 4 · Evidence ledger + re-verification (~4h). ✅ **Done 2026-11-12**
**Built:** `memory/extract.ts` (background extraction with Flash-Lite + JSON schema + zod; claims linked only to sources the answer cited; supersede history; title on first exchange only; topics accumulate), `ExtractionQueue` with an idle barrier (C6), `llm/json.ts`, `GET /api/conversations/:id/evidence`, and **code-driven prefetch of recorded pages** (ADR-027). 67 unit tests.

**Live round trip, no fixtures** (scratch DB, clock moved between days):

| Step | Result |
|---|---|
| "3 Nov": compare Neon / Supabase / Render entry plans | answer 6.4s; extraction **2.4s in the background**: 6 claims with source URLs, title + 6 topics |
| "11 Nov": "Last Tuesday I asked about Postgres hosting. Changed?" (first version) | recalled the real 3 Nov chat (resolved by topic), 6-row checklist table, verbatim then-values, 6.0s, **but the model invented `site:` queries to re-read pages** |
| Same, with prefetch (ADR-027) | code re-reads the 5 recorded pages before the model runs → **one model step, 4.5s**, primary pages cited |
| Real exchange "Let's shortlist HubSpot, Pipedrive, Close, Attio and Zoho. Salesforce is too heavy." | extracted `shortlist` (exact five) + `preference` (Salesforce too heavy) in 1.9s; the planner built the 5-item checklist from it |

Planned items:
- Persist sources with excerpt and hash. Async extraction (small model, structured output) → title, topics, claims, notes.
- Re-verification prompt policy: re-read cited URLs, date-bounded search, a changed / unchanged / couldn't-verify table.
- **Exit:** examples 1 and 3 pass on seeded data. Answers name the date, the old value, the new value and both sources.

## Phase 5 · Speed + quality pass, driven by evals (~3h)
- Eval runner (`npm run eval`): scenarios, deterministic checks, LLM judge, latency, search count and cost per scenario.
- Prompt caching verified. Search cache. Thinking-level and model sweep across the available Gemini models (and Claude Opus 5.5 / Sonnet 5.5 once a key exists).
- Tune the search-or-not policy, source-quality guidance and answer style (concise, tables for comparisons).
- Prompt-injection and provider-failure scenarios.
- **Exit:** a scorecard in `evals/RESULTS.md` with before and after numbers for each change.

## Phase 6 · Polish + write-up (~2h). ✅ **Done 2026-11-12** (done before Phase 5, at the user's request; Phase 5 testing is on hold)
**Built:**
- UI (ADR-029): citation hover cards (Radix), verdict badges, scrollable tables with sticky headers, recall chips, the "How I answered" trace, progress steps, retry, copy, chat filter, Esc to stop, favicon. Checked in light, dark and mobile via headless Chrome screenshots.
- Answer shape: exact table headers (the model had copied the format hint into the header row).
- Diagrams (ADR-030): four phase diagrams + an evolution file, generated from one spec, also rendered via the Excalidraw connector.
- `DESIGN.md` (one page) and a reviewer-facing README.

Planned items:
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
