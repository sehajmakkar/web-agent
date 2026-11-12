import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { extractKeywords, planMemory } from "../src/memory/retrieve.js";
import { loadSeedSet, seed } from "../src/memory/seed.js";
import { Store } from "../src/memory/store.js";

const NOW = new Date("2026-11-11T10:00:00Z");
const TZ = "Europe/London";

function seeded(set = "base") {
  const store = new Store(openDb(":memory:"));
  seed(store, loadSeedSet("evals/fixtures/history.yaml", set));
  return store;
}
const plan = (store: Store | undefined, text: string) => planMemory(store, { text, now: NOW, tz: TZ });

describe("planMemory: assignment examples on seeded history", () => {
  it("B1: 'last Tuesday … Postgres hosting' resolves to 3 Nov by topic (10 Nov is the Lisbon offsite)", () => {
    const p = plan(seeded(), "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(p.trace.dates[0]).toMatchObject({ ambiguous: true, resolved: "Tue 3 Nov 2026" });
    expect(p.trace.recalled.map((r) => r.id)).toContain("conv-2026-11-03-postgres");
    expect(p.trace.recalled.map((r) => r.id)).not.toContain("conv-2026-11-10-offsite");
    expect(p.since).toBe("2026-11-03");
    expect(p.memoryBlock).toContain("Neon · Launch plan price: $19/mo (source: https://neon.com/pricing)");
    expect(p.memoryBlock).toContain('1. Neon, Launch plan price: recorded "$19/mo" on Tue 3 Nov 2026 (source then: https://neon.com/pricing)');
    // ADR-027: the code will re-read exactly these before the model runs.
    expect(p.verifyUrls).toEqual(["https://neon.com/pricing", "https://supabase.com/pricing", "https://render.com/pricing"]);
  });

  it("no prefetch for questions that aren't about change", () => {
    expect(plan(seeded(), "What did I ask you about Postgres hosting last Tuesday?").verifyUrls).toEqual([]);
  });

  it("B2: truly ambiguous when both Tuesdays discussed Postgres hosting", () => {
    const p = plan(seeded("ambiguous_tuesday"), "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(p.trace.dates[0]).toMatchObject({ ambiguous: true, resolved: null });
    expect(p.contextLines.join("\n")).toContain("AMBIGUOUS");
    expect(p.since).toBe("2026-11-03"); // earliest candidate: never miss a change
    const ids = p.trace.recalled.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["conv-2026-11-03-postgres", "conv-2026-11-10-postgres"]));
    // Phase 5 eval B2: the code tells the model to name both days, not silently pick the one with recorded claims.
    expect(p.memoryBlock).toMatch(/ambiguity_policy: "Last Tuesday" could mean Tue 10 Nov 2026 or Tue 3 Nov 2026/);
    expect(p.memoryBlock).toContain("Never silently pick one");
  });

  it("no ambiguity policy when topic resolved the date", () => {
    expect(plan(seeded(), "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?").memoryBlock).not.toContain("ambiguity_policy");
  });

  it("C1: 'On Monday we shortlisted 5 CRM tools…' recalls the recorded shortlist (Attio in, Salesforce out)", () => {
    const p = plan(seeded(), "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?");
    expect(p.trace.dates[0]).toMatchObject({ resolved: "Mon 9 Nov 2026", ambiguous: false });
    expect(p.trace.recalled.map((r) => r.id)).toEqual(["conv-2026-11-09-crm"]);
    expect(p.since).toBe("2026-11-09");
    expect(p.memoryBlock).toContain('"items":["HubSpot","Pipedrive","Close","Attio","Zoho CRM"]');
  });

  it("A1: 'What did I ask you on 3 November? Still correct?' recalls BOTH 3 Nov conversations", () => {
    const p = plan(seeded(), "What did I ask you on 3 November? Is your answer still correct today?");
    expect(p.trace.recalled.map((r) => r.id).sort()).toEqual(["conv-2026-11-03-pooler", "conv-2026-11-03-postgres"]);
    expect(p.since).toBe("2026-11-03");
  });
});

describe("planMemory: cold start and non-memory turns", () => {
  it("D: no history → explicit 'no earlier conversations' coverage, still a search window", () => {
    const p = plan(new Store(openDb(":memory:")), "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?");
    expect(p.memoryBlock).toContain("NO earlier conversations are recorded");
    expect(p.trace.recalled).toEqual([]);
    expect(p.since).toBe("2026-11-09");
    expect(p.memoryBlock).toContain("no_record_policy: PROCEED"); // ADR-019: checkable → labelled assumption + search
  });

  it("D1: cold 'what did I ask' → no-record policy offers a next step instead of searching", () => {
    const p = plan(new Store(openDb(":memory:")), "What did I ask you on 3 November? Is your answer still correct today?");
    expect(p.memoryBlock).toContain("Don't search or guess");
  });

  it("memory intent but nothing matches → says so explicitly", () => {
    const p = plan(seeded(), "What did I ask you on 5 November?");
    expect(p.memoryBlock).toContain("recalled: NOTHING matches");
  });

  it("'since 1 November' sets the window even without memory (fixes the Phase 1 leak)", () => {
    const p = plan(seeded(), "Has HubSpot, Pipedrive or Attio changed pricing since 1 November?");
    expect(p.since).toBe("2026-11-01");
  });

  it("plain question: no window, no forced recall", () => {
    const p = plan(seeded(), "What's the latest Node.js release?");
    expect(p.since).toBeUndefined();
    expect(p.trace.recalled).toEqual([]);
    expect(p.memoryBlock).toContain("recent_conversations");
  });

  it("strong topic match surfaces a related past conversation without being asked", () => {
    const p = plan(seeded(), "Which CRM would suit a sales team of 20 best?");
    expect(p.trace.recalled.map((r) => r.id)).toEqual(["conv-2026-11-09-crm"]);
  });

  it("no store at all (CLI without DB) still renders coverage", () => {
    expect(plan(undefined, "hi").memoryBlock).toContain("NO earlier conversations");
  });
});

describe("extractKeywords", () => {
  it("drops stopwords, dates and memory phrasing", () => {
    expect(extractKeywords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?")).toEqual([
      "postgres", "hosting", "pricing",
    ]);
  });
});
