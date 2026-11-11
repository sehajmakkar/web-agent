# CLAUDE.md

Chat agent with web search, built as a hiring assignment for Minimi. The reviewers judge **architecture**:
how fast it answers, whether it gets things right, how good it is to talk to. They also read the code and DESIGN.md.
Read `docs/THINKING.md` first for the why.

## Commands
- `npm install && npm run dev`: server (Hono, `tsx watch`) + UI (Vite) via `concurrently`. This must always work on a fresh clone.
- `npm run ask -- "question"`: one headless turn through the same `runTurn()`, printing status, answer, cited sources and metrics.
- `npm test`: unit tests (vitest, `tests/`). Temporal resolver and memory retrieval must stay covered. `npm run typecheck`: tsc (TypeScript 7).
- `npm run eval [-- --live] [-- --filter=B]`: scenario evals (see docs/EVALS.md).
- `npm run seed:demo`: (re)loads backdated fixture history into `data/demo.db` (`-- --set ambiguous_tuesday` for the other set).
- `npm run demo`: reseed + run on ports 5180/8790 with the clock anchored at 2026-11-11 10:00 London. Never touches `data/agent.db`.
- Ports: dev 5173 (UI) / 8787 (API); override with `WEB_PORT` / `PORT`. Vite uses `strictPort`.

## Env
See `.env.example`. `LLM_PROVIDER` (`gemini` now, `anthropic` preferred later), `GEMINI_API_KEY`, `EXA_API_KEY` (primary search),
`TAVILY_API_KEY` (fallback search), and optionally `GEMINI_MODEL` (default `gemini-3.5-flash`), `GEMINI_EXTRACT_MODEL` (default `gemini-3.5-flash-lite`),
`GEMINI_FALLBACK_MODELS`, `AGENT_NOW` (frozen clock, ISO), `AGENT_TZ`, `DB_PATH`.
Phase 0 spikes: `node --env-file=.env spikes/phase0/{models,search}.mjs`. Findings are in `spikes/phase0/README.md`.

**Availability constraint (C-0):** only a Gemini key exists right now. The design targets Claude. Code runs on Gemini through `src/llm/`.

## Layout
```
src/server/   Hono routes, SSE. No agent logic here.
src/agent/    loop.ts (the agent loop), context.ts (ALL prompt assembly), prompts/ (system prompt text)
src/llm/      ModelClient interface + gemini.ts (now) / anthropic.ts (preferred, later). ONLY place provider SDKs are imported.
src/tools/    webSearch.ts (the one tool), sources.ts (SourceRegistry, citation validation)
src/search/   provider interface, tavily.ts, exa.ts, cache.ts
src/memory/   temporal.ts (date resolver), retrieve.ts (planMemory: the <memory> block + since), store.ts (all SQL), seed.ts, extract.ts (Phase 4)
src/db/       schema.sql, migrations, client
src/lib/      clock.ts, logger.ts
web/          Vite + React UI
evals/        scenarios.yaml, fixtures/history.yaml (runner in Phase 5)
scripts/      ask.ts (headless turn), seed-demo.ts (Phase 2)
tests/        vitest unit tests
spikes/       Phase 0 probes + findings (not part of the app)
```

## Invariants (don't break these)
1. **Time comes only from `src/lib/clock.ts`.** Never call `Date.now()` / `new Date()` elsewhere. Evals depend on it.
2. **All prompt text lives in `src/agent/prompts/`** (chat: `system.ts`, extraction: `extract.ts`). Chat input is assembled in `src/agent/context.ts`, extraction input in `src/memory/extract.ts`. No prompt strings anywhere else.
3. **Static prefix stays static.** No dates, IDs or memory in the top-level system prompt or tool definitions (prompt cache). Per-turn facts go in the trailing system message.
4. **Never invent memory.** Past-conversation content shown to the model must come from the DB, with coverage stated.
5. **Web content is untrusted.** Always wrap it in the tool result's untrusted block. Never put it in the system role.
6. **Citations are validated server-side** against the sources the tool returned.
7. **`web_search` is the only tool the model sees** (ADR-005, pending). Memory reaches the model through context injection, not tools.
8. Agent core (`agent/`, `memory/`, `tools/`, `search/`) must not import from `server/` or `web/`, or import any provider SDK directly (use `src/llm/`).
9. **The server owns history** (ADR-022). Never accept conversation history from the client. Save the user message before running the turn.
10. Don't kill processes you didn't start. The user often has `npm run dev` (5173/8787) and/or `npm run demo` (5180/8790) running. Don't delete DB files a server may have open: reseed in place.
11. **The answer is the final step's text** (ADR-024). Anything with one correct answer (dates, windows, recorded values, the no-record policy) is decided in `planMemory`, not left to the model ("code decides, the model writes").
12. Extracted evidence is validated before it's written (ADR-028): claims link only to sources the answer cited; never write unvalidated model JSON.
13. Inspect memory: `GET /api/conversations/:id/evidence` (claims, notes, topics). Debug a turn: `DB_PATH=data/demo.db AGENT_NOW=2026-11-11T10:00:00Z ASK_TRACE=1 npm run ask -- "…"` prints the memory plan and every executed search.

## Conventions
- TypeScript strict, ESM. zod for every tool input and external API response.
- Raw SQL in `src/db` and `src/memory/store.ts`, no ORM. Migrations are numbered `.sql` files.
- Provider SDKs used directly behind `ModelClient` (no LangChain/AI SDK, ADR-002). Now: `@google/genai`, model IDs from env only (ADR-017).
- Gemini gotchas: SSE uses CRLF framing; send `thoughtSignature` parts back unchanged; `thinkingLevel` on 3.x. Expect 429/503, so always go through the fallback chain.
- The code sets `since` on searches from the date resolver. Don't rely on the model to fill it (ADR-018).
- Preferred later: Claude Opus 5.5 (`claude-opus-5-5`) + Haiku 5.5 for extraction. On Opus 5.5: no `thinking: disabled`, no forced `tool_choice`, effort via `output_config.effort`.
- Any new dependency or architectural choice gets an ADR in `docs/DECISIONS.md`. Any new hard problem goes in `docs/CHALLENGES.md`.
- Any behavior change gets an eval scenario.

## Docs
- `docs/THINKING.md`: the reasoning narrative (interview walkthrough)
- `docs/ARCHITECTURE.md`: components, turn flow, data model
- `docs/DECISIONS.md`: ADR log
- `docs/CHALLENGES.md`: hard problems and their status
- `docs/PLAN.md`: phased build plan
- `docs/EVALS.md`: scenario families and metrics
- `DESIGN.md`: the one-page deliverable, written last from the real system
