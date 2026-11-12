# Design

A chat agent with one tool, `web_search`, built around one observation about your test set: **"has anything changed since Monday?" is not a search problem, it's a memory problem with a clock in it.** The agent remembers what it told you, *when*, and *from which page*, so it can re-check exactly that.

Diagrams: [`docs/diagrams/`](docs/diagrams) (four phases, each showing what changed). Full reasoning: [`docs/DECISIONS.md`](docs/DECISIONS.md) (30 ADRs).

## How a turn works

```
browser ──SSE──► server (owns history) ──► planMemory()  ── code, no LLM, ~ms ──────────────────────┐
                                           1 resolve dates: "last Tuesday" → 10 or 3 Nov (flagged)   │
                                           2 recall past chats in those windows, settle by topic     │
                                           3 coverage line ("history starts today") + 30-day index   │
                                           4 search window `since`, applied by code to every search  │
                                           5 change question? → checklist of recorded values,        │
                                             re-read the pages cited back then (before the model)    │
                                                                                                    ▼
          answer ◄── agent loop: stream ⇄ web_search (parallel queries · Exa → Tavily) ◄── prompt + <memory>
             │
             └──► saved, then extracted in the background (Flash-Lite → claims linked to their [n] source,
                  user decisions like shortlists, topics) → SQLite ledger for the next "has it changed?"
```

## Why it's built this way

1. **Code decides, the model writes.** Every memory flow failed live at least once, and each fix took a decision away from the model: whether to set `since` (it never did), what "on Monday" means (every model read it as *next* Monday), where the "then" value comes from (it restated it from today's page and missed a real change), whether to proceed with no history (it just asked), and which pages to re-check (it invented `site:` queries). Each is now deterministic, unit-tested and visible in the UI's **"How I answered"** trace. That's why a *small* model handles these flows.
2. **Store what we saw, not just what we said.** Each answer leaves source snapshots and claims (`Neon · Launch plan price · $19/mo · neon.com/pricing · 3 Nov`). A new claim links to the one it supersedes. Re-verification is a diff against the ledger, not the model trusting its old prose.
3. **Memory is context, not a tool.** The brief says one tool, so memory never becomes a second one. It's retrieved by SQL before the model runs and injected with an explicit coverage line. This is faster (no round trip), more reliable (the model can't forget to look), and makes invented history easy to refuse: *"I don't have a record of a conversation on Tue 3 Nov."*
4. **Honest on a cold start.** Your reviewers start with an empty database. The agent states it has no record, then, if the question is checkable, answers for a clearly **labelled** assumption and invites correction.
5. **Own the loop.** About 150 lines over the provider SDK, behind a 4-method `ModelClient` interface. Every token the model sees is assembled in one file.
6. **Make time testable.** One clock module and `AGENT_NOW`. `npm run demo` seeds backdated chats and anchors the clock at Wed 11 Nov, so your three example prompts work word for word.

## Considered and rejected

| Option | Why not |
|---|---|
| LangChain / LangGraph / Mastra | Hide the loop and prompts; their memory has no notion of time. The architecture *is* what's judged. |
| Vercel AI SDK | Strongest alternative, reconsidered when I had to switch providers. The interface I needed is ~100 lines; the neutral layer flattens provider features. |
| Provider-hosted search (Anthropic / Gemini grounding) | No date filter, no page content to snapshot, no cache. |
| Tavily as primary | Measured: Exa p50 0.7s vs 1.9s; vendor's own page in the top 3 for 13/14 queries vs 10/14. Tavily stays as the fallback. |
| A `recall` tool | Breaks "one tool", and the model can forget to call it. |
| Vector DB / embeddings | Your queries are anchored by date + named topic. SQLite FTS5 + extracted topics cover that with zero setup. |
| A date library (chrono) | Picks *one* date; I need *all* candidates plus an ambiguity flag, with rules I can explain. |

**Constraint:** only a Gemini key was available, so it runs `gemini-3.5-flash-lite`. The design targets Claude. Switching is one adapter file plus one env var, and the eval suite decides.

## What I measured (live, Flash-Lite)

| | Result |
|---|---|
| Your 3 examples, with history | correct date (incl. ambiguous "last Tuesday" → 3 Nov by topic), recorded shortlist, per-item verdicts: **4.5–7.5s** |
| Your 3 examples, empty DB | "no record" first, then a labelled guess + search, or a next step: **1.3–5.4s**, never invented |
| Re-check with code-driven page re-reads | 2 model steps → 1: **6.0s → 4.5s** |
| No-search turn | **1.4s**, zero searches |
| Background extraction | **~2s**, off the critical path |

67 unit tests cover the date resolver, memory planner, ledger, citations and tool. Logs: [`docs/PLAN.md`](docs/PLAN.md).

## Known gaps

Flash-Lite still misses subtle unit changes ("per project" → "per org") and once dated an event by its article date. The architecture isolates these as model-quality issues ([C23](docs/CHALLENGES.md)). Claims inherit the quality of the source the answer cited ([C25](docs/CHALLENGES.md)).

## With another week

- **Eval runner + scorecard** (`npm run eval`): the 10 scenarios are written; add recorded search replay, LLM judge, p50/p90.
- **Model sweep:** Flash vs Flash-Lite, more thinking only on change turns, and the Claude adapter head to head.
- **Watchlists:** "tell me if any of these 5 change pricing", a scheduled re-check of the ledger.
- **Primary-source preference** when ledgering (re-read the vendor page when a claim came from a blog).
- Embeddings for paraphrase recall; per-user auth; prompt caching once the prefix is long enough to qualify.
