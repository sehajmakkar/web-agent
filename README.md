# Web Agent

A chat agent with one tool, web search, built around **memory, time and change**: it remembers what it told you,
when, and from which sources, so "has anything changed since Tuesday?" gets a precise answer.

> Status: Phase 1 (streaming chat + live search + citations). See [docs/PLAN.md](docs/PLAN.md).

## Run it

```bash
cp .env.example .env     # add GEMINI_API_KEY and EXA_API_KEY (Tavily optional fallback)
npm install
npm run dev              # UI → http://localhost:5173   API → http://localhost:8787
```

Headless single turn: `npm run ask -- "What's the latest Node.js release?"`

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
