# How I approached this (interview narrative)

This is the story of how the design came about, in the order I thought it through.
It is meant to be walked through out loud in ~5 minutes.

---

## 1. Read the examples, not the headline

The headline says "chat agent with one tool: web search". Every candidate will build that.
The three example prompts from their dataset say something more specific:

| Example | What it actually requires |
|---|---|
| "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?" | Recall a **past conversation by relative date** → recover a **decision the user made** (the 5 names) → search for **changes after a specific date** → compare. |
| "What did I ask you on 3 November? Is your answer still correct today?" | **Timestamped episodic memory** → retrieve the exact Q and A → **re-verify my own past answer** against today's web → admit if I was wrong. |
| "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" | Relative date that is **ambiguous** (said on Wed 11 Nov: the 10th or the 3rd?) → topic match → **diff specific numbers I quoted then** against numbers now. |

**Insight:** none of the three is really a "web search" question. All three are about
**memory + time + change**. Web search is table stakes. What sets an answer apart is whether the
agent remembers *what it saw, when it saw it, and where*, and can compare that with what's true now.

## 2. What "as good as the best ones on the internet" means

The ChatGPT/Perplexity/Claude.ai baseline: streams immediately, cites sources, knows today's date,
searches only when it needs to, remembers you across chats, says "I don't know" instead of guessing.
They judge on three things, so I made those the design axes:

1. **Answers fast.** Low time-to-first-token, parallel searches, no search when it isn't needed.
2. **Gets things right.** Grounded in fresh, primary sources; dates computed, not guessed; memory never invented.
3. **Good to talk to.** Concise, remembers context, asks only when ambiguity matters, shows its work.

## 3. Four design calls that follow from that

**a. Store what we *saw*, not just what we *said*.**
If I only keep the transcript, "has pricing changed?" means re-reading my own prose and trusting
it. Instead every answer leaves behind an **evidence ledger**: claims (`Neon · Launch plan · $19/mo`)
with source URL, quote, and `observed_at`. Re-verification becomes a diff of structured facts,
not the model trying to remember.

**b. Dates are code, not vibes.**
LLMs are unreliable at "what date was last Tuesday?". A deterministic resolver (in the user's
timezone) turns "Monday", "3 November", "last Tuesday" into concrete date windows, and flags
ambiguity. The model gets facts like `"last Tuesday" → Tue 10 Nov OR Tue 3 Nov (ambiguous)`.

**c. Memory isn't a tool the agent chooses to use. It's context the agent always has.**
Each turn gets a cheap (~ms) SQLite lookup: a compact index of recent conversations plus anything
in the resolved date windows. The model starts the turn already knowing "on Mon 9 Nov you
shortlisted HubSpot, Pipedrive, ...". It needs zero extra round trips, so it's faster, and the model
can't forget to check, so it's more reliable. It also keeps us literally within "one tool: web search".

**d. Make time testable.**
You can't test "what did I ask on 3 November?" without a history from 3 November. An injectable
clock (`AGENT_NOW`) and a seed script make every example reproducible, both for my evals and
for the reviewers.

## 4. Own the loop

Their judging statement is "the best architecture wins", so the architecture has to be visible
in the code. The agent loop is ~150 lines on the raw Anthropic SDK: stream → tool calls in parallel →
results → stream. No LangChain or LangGraph hiding the prompts. Every token the model sees is
assembled in one file I can explain line by line. (Full reasoning in DECISIONS.md, ADR-002.)

## 5. Honesty is a feature

When the reviewers first open the app the database is empty. Their first message might be
"What did I ask you on 3 November?". The worst possible answer is a confident invented one. The
right answer: *"I don't have any conversation from Tue 3 Nov; our history starts today. If you
paste what you asked, I'll check whether it still holds."* This is a test case, not an edge case.

## 6. Prove it with evals

I turned the three examples into ~30 scenarios: seeded history, frozen clock, warm and cold
memory, an ambiguous date, a no-search chit-chat turn, prompt injection. They're scored with
deterministic checks (did it resolve the right date? did it cite? did it invent memory?) plus an
LLM judge. Every prompt or architecture change runs against them. (See EVALS.md.)

## 7. A real constraint, handled as one

I only had a Gemini key. I designed for Claude (my preferred model for this) but built against a
narrow `ModelClient` interface. Gemini lives in one adapter file. The loop, memory, tools and evals
don't know which model they're talking to. Switching costs one file and one env var, and the
eval suite decides which model ships. Constraints are normal; letting them leak through the codebase isn't.

## 8. Measure before building (Phase 0)

Before writing agent code I spent a couple of hours on probes. Four findings changed the design:
- **The newest model wasn't usable** (3.8 Flash: 20 requests/day on the free tier, plus 503s). So I chose 3.5 Flash with a fallback chain.
- **The model never filled the `since` parameter.** So the code sets it from the date resolver (ADR-018). Don't hand the model a job the code can do reliably.
- **Every model read "on Monday" as next Monday.** That's direct evidence for resolving dates in code.
- **Exa beat Tavily** on speed (0.7s vs 1.9s) and on returning the vendor's own page. For "HubSpot pricing change" it found hubspot.com's announcement; Tavily found LinkedIn posts.

## 9. "Code decides, the model writes" (the pattern behind Phase 3)

Each memory flow failed live at least once, and the fix was the same every time: **take the decision away from the model and give it a structure to fill in.**

| Failure seen live | The model was deciding… | Now decided in code |
|---|---|---|
| "since 1 Nov" answer included Sep/Oct news | whether to set `since` | planner sets the window on every search (ADR-018) |
| unverified draft table, then a search | when the answer starts | only the final step is the answer (ADR-024) |
| "then: ~$15/mo" when $19/mo was recorded | where the "then" value comes from | verbatim checklist from the ledger (ADR-025) |
| cold start: just asked for the list | whether to proceed or ask | `no_record_policy` (ADR-026) |
| "on Monday" read as next Monday | what a date means | deterministic resolver (ADR-008) |
| invented `site:` queries to re-check recorded pages | which pages to re-read | code re-reads them before the model runs: one step instead of two, 6.0s → 4.5s (ADR-027) |

The model still does what it's good at: reading pages, judging relevance, writing the answer. Everything with one correct answer (dates, windows, what we recorded, what the policy is) is code, unit-tested, and shown in the turn trace. That's also why a *small* model (Flash-Lite) handles these flows. Where it still falls short (C23) is cleanly separated from architecture problems.

## 10. Make the architecture visible in the product

The "How I answered" panel under each answer shows what the **code** decided (dates, recalled conversation, search
window, pages re-read) apart from what the **model** chose (its searches), with timings. In a demo you can point at it:
the design argument is right there in the UI, not only in the docs. The diagrams in `docs/diagrams/` tell the same
story phase by phase.

## 11. The iteration path

I built it in thin vertical slices, each one usable on its own (PLAN.md):
skeleton chat + search → persistence + clock → temporal memory → evidence ledger + re-verification
→ speed + evals → polish + DESIGN.md.

---

## 30-second pitch

> "All three of your examples are about time and memory, not search. So I built the agent
> around an evidence ledger: every answer stores the claims it made, with source and timestamp.
> Relative dates are resolved in code, and past conversations are retrieved before the model even
> runs. 'Has anything changed since Tuesday?' then becomes a precise diff instead of a guess.
> I own the agent loop instead of using a framework, so every prompt and every token is
> explainable. And there's an injectable clock so you can test it on 3 November."
