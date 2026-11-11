# Challenges

The hard problems, how we handle each one, and how we'll know it works.
Status: `open` / `mitigated` / `verified (eval #)`.

---

## Memory and time

### C1 · Ambiguous relative dates. `open` (Phase 0: models resolve "on Monday" to the *next* Monday, see ADR-008)
Said on Wed 11 Nov, "last Tuesday" can mean Tue 10 Nov or Tue 3 Nov. "On Monday" means 9 Nov.
**Approach:** the resolver returns *all* candidates and an `ambiguous` flag. Memory retrieval checks
every candidate window. If only one has a matching topic, use it and **state the date** in the answer
("On Tue 3 Nov you asked…"). If several match, briefly ask which one, or answer both when that's cheap.
**Eval:** seeded matches on both Tuesdays, one Tuesday, and neither.

### C2 · Cold start: invented memories. `open`
The reviewers' database is empty. "What did I ask you on 3 November?" must not get a made-up answer.
**Approach:** the turn context always states the coverage of memory explicitly ("history covers
11 Nov–today; nothing on 3 Nov"). The system prompt has a hard rule: never assert past conversation
content that isn't in the provided memory. Offer a next step instead: "paste it and I'll check it".
**Eval:** cold versions of all three examples. Any invented recall is an automatic fail.

### C3 · Recovering what the *user* decided, not just what I said. `open`
"The 5 we shortlisted": the shortlist may have come out of a back-and-forth, with names spread across several messages.
**Approach:** extraction produces `notes{kind:"shortlist", items:[...]}`. If none exists, the model reads the window's messages through the injected digest or `recall`.

### C4 · Topic matching across paraphrase. `open`
"Postgres hosting" vs "managed database" vs "Neon vs Supabase".
**Approach:** FTS5 on raw text plus small-model `topics` tags written at extraction time (synonyms and vendor names). Embeddings are the plan for another week.

### C5 · Timezones. `open`
"3 November" means the user's 3 November.
**Approach:** store UTC plus the tz the conversation used, and resolve in the user's current tz. The browser sends the tz.

### C6 · Async extraction race. `open`
A follow-up arrives before claims are extracted.
**Approach:** raw messages and sources are saved synchronously. Retrieval waits up to ~1s for in-flight extraction, then degrades to raw text.

## Correctness of the answer

### C7 · "Is your answer still correct?" means re-verify, not re-assert. `open`
The model tends to agree with its past self.
**Approach:** the prompt frames the past answer as a *claim to check*. Re-read the cited URLs live and run fresh searches. Output has three categories: **changed**, **verified unchanged** (with today's source) and **couldn't verify**. If the old answer was wrong *at the time*, say so plainly.

### C8 · Detecting "changed since X" when pages have no dates. `open`
Pricing pages are usually undated, and search engines' `published_at` is noisy.
**Approach:** two signals. (1) **Snapshot diff**: compare stored claims and excerpts with the live page. (2) **Date-bounded search** for news, changelogs and "pricing update" posts after X. Changelog and blog pages from the vendor's own domain rank above third-party coverage.

### C9 · Stale training knowledge vs today. `open`
The model "knows" last year's prices.
**Approach:** today's date is in every turn context. Rule: for anything time-sensitive (prices, versions, people in roles, events) search or say the info is unverified. Never present remembered prices as current.

### C10 · Source quality and conflicts. `open`
SEO spam, outdated comparison blogs, sources that disagree.
**Approach:** prompt guidance to prefer primary sources (vendor pricing, docs, changelogs, official announcements). Surface conflicts instead of averaging them. Show each source's date when known.

### C11 · Prompt injection through web content. `open`
**Approach:** results go into the tool result wrapped as `<untrusted_web_content>` with an explicit rule: data, never instructions. The model has no dangerous tools, which limits the blast radius.
**Eval:** a fixture page containing "ignore previous instructions…".

## Speed

### C12 · Fan-out vs latency. `open`
5 CRMs × (pricing + news) = 10+ lookups.
**Approach:** batched `queries[]` in one tool call, executed in parallel. Re-read known URLs directly instead of searching for them. A wall-clock budget, with an honest list of what wasn't checked when it runs out.
**Target:** a multi-entity re-check in ≤ ~15s, with the first visible token or status in < 1.5s.

### C13 · When to search at all. `open`
Over-searching is slow; under-searching is wrong.
**Approach:** prompt policy. Search for anything time-sensitive, niche or verifiable. Skip for chit-chat, math, rewriting and stable concepts. The eval tracks search count on no-search prompts.

### C14 · Prompt caching vs a changing date. `mitigated (design)`
**Approach:** the static prefix is cached. Date and memory go last (ADR-010): a `<turn_context>` block on the current user turn on Gemini, a mid-conversation system message on Claude. Verify cache-hit token counts in the usage metadata.
Phase 1 observation: `cachedContentTokenCount` was 0 on every turn (the prefix is ~900 tokens, possibly below Gemini's implicit-cache minimum). Re-check in Phase 5 with longer histories. Explicit context caching is the option if it matters.

### C19 · The model doesn't use tool parameters it should. `mitigated (design, ADR-018); confirmed in Phase 1`
Phase 0: Gemini batched queries but never set `since`, so the date went into the query text, which search engines treat loosely.
Phase 1, a real failure: "changed pricing since 1 November?" → the model wrote "November 2026" into the queries with no `since`, and the answer included a Sep 18 item and an Oct 15 item. The plumbing for code-owned `since` (`forcedSince`) is in place and unit-tested. The Phase 3 resolver will feed it.
**Approach:** the code sets `since` from the resolver. Other important parameters get the same treatment: anything that can be derived reliably from turn context is set by code, not left to the model.

### C20 · Latency variance from the model API. `open`
Phase 0: the same tool-decision request took 1.6s once and 10.7s the next time.
**Approach:** stream status events immediately ("Checking memory…", "Searching 4 queries…") so the UI never looks frozen. Use per-call timeouts, falling back to the next model after a time limit. Record p50 and p90 in the eval, not single numbers.

### C18 · Building on a non-preferred model [C-0]. `open`
Only a Gemini key is available. Risks: different tool-calling quirks, different instruction-following on the "never invent memory" rule, and model IDs we can't assume.
**Approach:** `ModelClient` interface keeps provider code in `src/llm/`. Model IDs come from env and are checked against the Models endpoint. The eval suite is provider-agnostic, so when a Claude key exists we run both and compare on numbers.

## Operations

### C15 · Provider failures and rate limits. `open` (Phase 0: seen in practice)
Phase 0 hit Gemini 503 "high demand", 90s timeouts and a 20-requests/day free-tier cap on `gemini-3.8-flash`.
**Approach:** a model fallback chain (ADR-017), with per-request timeouts and a switch to the next model on 429/503. The search provider falls back from Exa to Tavily. Retries with backoff in the search provider. If search fails, answer with an explicit "couldn't reach search, this is from my training data and may be stale". The model API uses the SDK's retries plus server-side refusal fallbacks.

### C16 · Evaluating time-dependent, non-deterministic answers. `open`
The web changes, so exact-match tests rot.
**Approach:** deterministic checks on *behavior* (right date resolved, right past conversation found, no invented memory, cited, searched with `since`), plus an LLM judge on a rubric. Search responses are recorded and replayed for the regression set. Live mode is kept for spot checks.

### C17 · Long histories and context growth. `open`
**Approach:** inject the index plus window hits only, never the full history. Inside a long conversation, rely on the large context, and summarize older turns past a threshold.
