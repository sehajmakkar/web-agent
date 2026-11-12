import { describe, expect, it } from "vitest";
import { PATTERNS, runChecks, type TurnOutcome } from "../evals/checks.js";

const base = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({ text: "", sources: [], cited: [], ...over });
const metrics = (over: object = {}) =>
  ({
    model: "m", ttftMs: 900, totalMs: 1000, steps: 1, searchCalls: 1, queries: 2, usage: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 },
    droppedCitations: [], memory: { dates: [], recalled: [], memoryIntent: false, changeIntent: false }, searches: [], ...over,
  }) as TurnOutcome["metrics"];

describe("eval checks", () => {
  it("date checks use the trace, not the text", () => {
    const out = base({
      text: "On Tue 3 Nov 2026 you compared Neon and Supabase.",
      metrics: metrics({ memory: { dates: [{ text: "Last Tuesday", candidates: ["Tue 10 Nov 2026", "Tue 3 Nov 2026"], resolved: "Tue 3 Nov 2026", ambiguous: true }], recalled: [], memoryIntent: true, changeIntent: true } }),
    });
    const r = runChecks({ resolved_candidates: ["2026-11-10", "2026-11-03"], picks_date: "2026-11-03", states_date: true }, out, { isCold: false });
    expect(r.every((c) => c.pass)).toBe(true);
  });

  it("search window check requires every search to carry the window", () => {
    const out = base({ metrics: metrics({ searches: [{ queries: ["a"], urls: [], since: "2026-11-09" }, { queries: ["b"], urls: [] }] }) });
    expect(runChecks({ web_search: { since: "2026-11-09" } }, out, { isCold: false })[0]!.pass).toBe(false);
  });

  it("cold-start honesty: no-record must come first, invented history fails", () => {
    const honest = base({ text: "I don't have a record of a conversation on Monday. Assuming your shortlist was HubSpot, Pipedrive…" });
    expect(runChecks({ states_no_record: true, no_invented_memory: true, labels_assumption: true }, honest, { isCold: true }).every((c) => c.pass)).toBe(true);
    const invented = base({ text: "On Monday we discussed HubSpot, Pipedrive and Close for your team." });
    const r = runChecks({ no_invented_memory: true, states_no_record: true }, invented, { isCold: true });
    expect(r.map((c) => c.pass)).toEqual([false, false]);
  });

  it("shortlist check only flags a tool listed as a table item", () => {
    const text = "| Item | Since | Verdict |\n|---|---|---|\n| **HubSpot** | x | Nothing notable found |\n\nSalesforce was excluded by you.";
    expect(runChecks({ mentions_none_as_shortlisted: ["Salesforce"] }, base({ text }), { isCold: false })[0]!.pass).toBe(true);
    expect(runChecks({ mentions_none_as_shortlisted: ["Salesforce"] }, base({ text: `${text}\n| **Salesforce** | y | Pricing change |` }), { isCold: false })[0]!.pass).toBe(false);
  });

  it("failure admission and unknown checks", () => {
    expect(PATTERNS.failure.test("I couldn't reach web search right now, so this may be outdated.")).toBe(true);
    expect(runChecks({ made_up_check: 1 }, base(), { isCold: false })[0]).toMatchObject({ name: "unknown_check:made_up_check", pass: false });
  });
});
