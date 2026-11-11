# Web Agent

A chat agent with one tool, web search, built around **memory, time and change**: it remembers what it told you,
when, and from which sources, so "has anything changed since Tuesday?" gets a precise answer.

> Status: Phase 3 (streaming chat, live search, citations, persistent conversations, temporal memory). See [docs/PLAN.md](docs/PLAN.md).

## Run it

```bash
cp .env.example .env     # add GEMINI_API_KEY and EXA_API_KEY (Tavily optional fallback)
npm install
npm run dev              # UI → http://localhost:5173   API → http://localhost:8787
```

Conversations are stored in `data/agent.db` (SQLite, created automatically).
Headless single turn: `npm run ask -- "What's the latest Node.js release?"`

## Demo with history ("time travel")

```bash
npm run demo             # UI → http://localhost:5180 (own ports and DB; can run beside `npm run dev`)
```

This loads backdated conversations (Tue 3 Nov: Postgres hosting; Mon 9 Nov: a CRM shortlist; Tue 10 Nov: something unrelated)
into `data/demo.db` and anchors the clock at **Wed 11 Nov 2026, 10:00 London**, so prompts like these work word for word:

- "What did I ask you on 3 November? Is your answer still correct today?"
- "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
- "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

With an empty history (plain `npm run dev`), the same prompts get an honest "I don't have a record of that", and then
a labelled best guess with a live search where that's possible.

## Keys

| Variable | Needed | What for |
|---|---|---|
| `GEMINI_API_KEY` | yes | The model (`gemini-3.5-flash-lite`, see ADR-017) |
| `EXA_API_KEY` | one of these two | Primary web search |
| `TAVILY_API_KEY` | one of these two | Fallback web search |

## Docs

- [docs/THINKING.md](docs/THINKING.md): how the design was reasoned out
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, turn flow, data model
- [docs/DECISIONS.md](docs/DECISIONS.md): every decision, with alternatives rejected
- [docs/CHALLENGES.md](docs/CHALLENGES.md): hard problems and their status
- [spikes/phase0/README.md](spikes/phase0/README.md): model and search provider measurements
