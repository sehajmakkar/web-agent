# Web Agent

A chat agent with one tool, live web search, that remembers **what it told you, when, and from which page**, so
"has anything changed since Tuesday?" gets a precise, cited answer instead of a guess.

**Start with [DESIGN.md](DESIGN.md)** (one page). Diagrams of how the architecture grew: [docs/diagrams/](docs/diagrams).

## Run it

```bash
cp .env.example .env     # add GEMINI_API_KEY and EXA_API_KEY (TAVILY_API_KEY optional, used as fallback)
npm install
npm run dev              # → http://localhost:5173  (API on :8787)
```

Requires Node 20.6+. Conversations are stored in `data/agent.db` (SQLite, created automatically, no setup).

### Try the memory flows with history: `npm run demo`

```bash
npm run demo             # → http://localhost:5180  (own ports + own DB; can run beside `npm run dev`)
```

This loads backdated conversations (Tue 3 Nov: Postgres hosting with prices; Mon 9 Nov: a CRM shortlist; Tue 10 Nov:
something unrelated) and sets the clock to **Wed 11 Nov 2026, 10:00 London**, so these work word for word:

- *What did I ask you on 3 November? Is your answer still correct today?*
- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?* ("last Tuesday" is ambiguous on a Wednesday; watch it resolve)

On an empty history (`npm run dev`), the same prompts get an honest *"I don't have a record of that"*, followed by a
clearly labelled best guess with a live search where that makes sense.

### What to look for in the UI

- **Recall chips** above an answer: which past conversation it used (click to open it).
- **Verdict badges** in re-check tables: <kbd>Changed</kbd> / <kbd>No change found</kbd> / <kbd>Couldn't verify</kbd>.
- **Hover a citation** `[n]` to see the source, domain and publish date.
- **How I answered** under each answer: the dates the code resolved (and how it settled ambiguity), the search window,
  pages re-read before answering, the searches the model chose, and timings.

## Keys

| Variable | Needed | What for |
|---|---|---|
| `GEMINI_API_KEY` | yes | The model, `gemini-3.5-flash-lite` (the only key available; the design targets Claude, see DESIGN.md) |
| `EXA_API_KEY` | one of these two | Primary web search |
| `TAVILY_API_KEY` | one of these two | Fallback web search |

Optional: `EXTRACT_ENABLED=false` saves quota (turns off background memory extraction), and `AGENT_NOW` sets the clock. All
options are in [.env.example](.env.example).

## Scripts

| | |
|---|---|
| `npm run dev` | UI + API with hot reload |
| `npm run demo` | backdated history + anchored clock, ports 5180/8790 |
| `npm run ask -- "…"` | one headless turn (`ASK_TRACE=1` prints the memory plan and every search) |
| `npm test` · `npm run typecheck` | 67 unit tests · TypeScript |
| `npm run seed:demo` | reset the demo DB in place |
| `npm run diagrams` | regenerate the architecture diagrams from their spec |

## Repo map

```
src/agent/     the loop (loop.ts), all prompt assembly (context.ts), prompt text (prompts/)
src/memory/    temporal.ts (date resolver) · retrieve.ts (planMemory) · extract.ts (ledger) · store.ts (all SQL)
src/tools/     web_search: the one tool · citation registry + validation
src/search/    Exa → Tavily fallback, cache
src/llm/       ModelClient interface + Gemini adapter (the only place a provider SDK is imported)
src/server/    Hono + SSE (transport only)
web/           Vite + React UI
docs/          THINKING (the reasoning) · ARCHITECTURE · DECISIONS (ADRs) · CHALLENGES · PLAN (phase logs) · EVALS · diagrams/
evals/         scenarios + backdated fixtures (also used by the demo)
spikes/phase0/ model and search-provider measurements that shaped the design
```
