# Phase 0 spike: model and search provider selection

Run on **Wed 11 Nov 2026** from a laptop on the Gemini free tier. Raw output is in the `*-results*.json` files next to this README.
Re-run with `node --env-file=.env spikes/phase0/models.mjs [model…]` and `node --env-file=.env spikes/phase0/search.mjs`.

## 1. Gemini model (constraint C-0: Gemini is the only LLM key)

### Candidates
`GET /v1beta/models` listed 50 models. The Flash / Flash-Lite text models: `gemini-3.8-flash`, `gemini-3.7-flash`,
`gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash(-lite)`, plus
`gemini-flash-latest` / `gemini-flash-lite-latest` aliases. All have 1M input and 65K output tokens, with thinking.

### Probe (4 tests × 2 runs per model, streaming)
`hello` = latency floor · `tools` = "has pricing changed since 3 Nov for Neon, Supabase, Render?" with a `web_search(queries[], since?)`
tool · `dates` = resolve "on Monday" / "last Tuesday" with no help · `extract` = JSON-schema claim extraction.

| Model | Availability | hello (time to first token) | tools (time to call) | Tool-call behavior | Extraction |
|---|---|---|---|---|---|
| gemini-3.8-flash | **503 "high demand", then 429: free tier = 20 requests/day/model** | — | — | — | — |
| gemini-3.7-flash | 503 and 90s timeouts | — | — | — | — |
| **gemini-3.5-flash** | ✅ | 1.7–4.3s | 2.5–3.1s | 1 call, 4 batched queries | valid JSON |
| **gemini-3.5-flash-lite** | ✅ | 1.3–4.1s | 1.6–10.7s | 1 call, 4 batched queries | valid JSON, 1.5–2.3s |
| gemini-3.1-flash-lite | ✅ | 1.5–6.7s | 2.3–4.3s | 1 call, 3 batched queries | valid JSON |

### Findings that change the design
1. **Newest ≠ usable.** 3.8 Flash has tiny free-tier quotas and capacity errors. → We need a **fallback chain** and retry/backoff in the adapter, not a single hard-coded model.
2. **Latency variance is large** (the same request took 1.6s and then 10.7s). → Perceived speed must come from streaming status events, not from expecting the model to be fast.
3. **The model batches queries well but never filled `since`.** It wrote "November 2026" into the query text instead. → When the user's message has a "since X" anchor, the **code** sets `since` from the date resolver. The model's value, if any, is only a hint. (CHALLENGES C19.)
4. **Unaided date reasoning is wrong for our case.** All three models read "on Monday" as the *next* Monday (16 Nov), even though the user meant the past. They do notice the "last Tuesday" ambiguity. → Confirms ADR-008: dates are resolved in code.
5. **Gemini adapter gotchas:** SSE events are framed with **CRLF** (`\r\n\r\n`), which broke a naive parser and looked like a 268s hang. Gemini 3.x returns **`thoughtSignature`** on parts, and these must be sent back unchanged in later turns with function calls. Thinking uses `thinkingConfig.thinkingLevel` on 3.x and `thinkingBudget` on 2.5.

### Decision (→ ADR-017)
- **Conversation: `gemini-3.5-flash`.** GA, available, good tool calls.
- **Extraction: `gemini-3.5-flash-lite`.** Cheapest; clean JSON.
- **Fallback chain on 429/503:** `gemini-3.5-flash` → `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite`.
- Revisit `gemini-3.8-flash` on a paid tier.

## 2. Search provider: Tavily vs Exa

15 queries shaped like the test set: pricing pages, "changed since" with a date filter, fresh news, stable facts.
`primary` = is the vendor's own domain in the top 3? `dated` = how many results carry a published date.

| Config | p50 latency | p90 latency | Primary source in top 3 | Results with a date | Results before `since` | Avg content per result |
|---|---|---|---|---|---|---|
| tavily-basic | 1.9s | 2.2s | 10/14 | 0/75 | 0 (no dates to check) | 1.2k chars |
| tavily-advanced | 3.0s | 3.5s | 6/14 | 0/75 | 0 (no dates to check) | 1.7k chars |
| exa-auto | 3.2s | 5.1s | 13/14 | 40/75 | 0 | 2.7k chars |
| **exa-fast** | **0.7s** | **1.0s** | **13/14** | **39/75** | **0** | **2.6k chars** |

Re-reading a known URL (re-verification path): Tavily `/extract` took 0.3–0.7s for 19–25k chars, and Exa `/contents` with `livecrawl: "always"` took 0.5–0.6s for 15k chars. Both are fine.

Spot checks: for "HubSpot pricing change", Exa's top hit was `hubspot.com/company-news/flexible-pricing`, while Tavily returned
LinkedIn and agency blogs. For "Neon pricing", Exa returned `neon.com/pricing`, `neon.com/docs/introduction/plans` and `neon.com/blog/new-usage-based-pricing`;
Tavily returned three third-party blogs.

Caveat: Tavily only returns `published_date` with `topic: "news"`, so its date counts above undersell it on news. Even so, the
primary-source and latency gaps decide it.

### Decision (→ ADR-004)
- **Primary: Exa.** `type: "fast"` by default, `type: "auto"` when the model asks for `depth: "thorough"`, `startPublishedDate` for `since`, and `/contents` + livecrawl for re-reading cited URLs.
- **Fallback: Tavily**, behind the same `SearchProvider` interface, used when Exa errors or times out (CHALLENGES C15).
- Why it matters: a ~0.7s search with primary sources and dates is what makes a 5-tool CRM re-check both fast and trustworthy.
