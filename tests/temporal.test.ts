import { describe, expect, it } from "vitest";
import { formatDay, resolveDates } from "../src/memory/temporal.js";

// Reference clock for the assignment's examples: Wed 11 Nov 2026, 10:00 London.
const NOW = new Date("2026-11-11T10:00:00Z");
const TZ = "Europe/London";
const r = (text: string, now = NOW, tz = TZ) => resolveDates(text, now, tz);
const dates = (text: string, now = NOW, tz = TZ) => r(text, now, tz).mentions.map((m) => m.candidates.map((c) => (c.from === c.to ? c.from : `${c.from}..${c.to}`)));

describe("assignment examples (said on Wed 11 Nov 2026)", () => {
  it("'On Monday we shortlisted…' → Mon 9 Nov (past, NOT next Monday)", () => {
    const m = r("On Monday we shortlisted 5 CRM tools for a 20-person sales team.").mentions;
    expect(m).toHaveLength(1);
    expect(m[0]!.candidates).toEqual([{ from: "2026-11-09", to: "2026-11-09" }]);
    expect(m[0]!.ambiguous).toBe(false);
  });

  it("'Last Tuesday I asked…' → ambiguous: Tue 10 Nov or Tue 3 Nov", () => {
    const res = r("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
    expect(res.mentions[0]!.ambiguous).toBe(true);
    expect(dates("Last Tuesday I asked you about Postgres hosting.")).toEqual([["2026-11-10", "2026-11-03"]]);
    expect(res.sinceThen).toBe(true);
  });

  it("'What did I ask you on 3 November? Is your answer still correct today?' → 3 Nov + today", () => {
    const res = r("What did I ask you on 3 November? Is your answer still correct today?");
    expect(dates("What did I ask you on 3 November? Is your answer still correct today?")).toEqual([["2026-11-03"], ["2026-11-11"]]);
    expect(res.mentions[1]!.isToday).toBe(true);
  });
});

describe("absolute dates", () => {
  it.each([
    ["since 1 November", "2026-11-01"],
    ["on November 3rd", "2026-11-03"],
    ["the 3rd of November", "2026-11-03"],
    ["Nov 3, 2025", "2025-11-03"],
    ["on 2026-10-15", "2026-10-15"],
  ])("%s → %s", (text, ymd) => {
    expect(dates(text)).toEqual([[ymd]]);
  });

  it("day+month without a year is the most recent past occurrence (year rollover)", () => {
    expect(dates("what did we discuss on 20 December?", new Date("2026-01-05T10:00:00Z"))).toEqual([["2025-12-20"]]);
    expect(dates("on 20 November")).toEqual([["2025-11-20"]]);
  });

  it("rejects impossible dates and the verb 'may'", () => {
    expect(dates("on 31 November")).toEqual([]);
    expect(dates("I may need this later")).toEqual([]);
  });

  it("marks 'since X' as a lower bound", () => {
    expect(r("Has anything changed since 1 November?").mentions[0]!.role).toBe("since");
    expect(r("What did I ask on 3 November?").mentions[0]!.role).toBe("reference");
  });
});

describe("relative expressions", () => {
  it.each([
    ["yesterday", [["2026-11-10"]]],
    ["the day before yesterday", [["2026-11-09"]]],
    ["3 days ago", [["2026-11-08"]]],
    ["a week ago", [["2026-11-02..2026-11-08"]]],
    ["last week", [["2026-11-02..2026-11-08"]]],
    ["earlier this week", [["2026-11-09..2026-11-11"]]],
    ["last weekend", [["2026-11-07..2026-11-08"]]],
    ["last month", [["2026-10-01..2026-10-31"]]],
    ["this Friday", [["2026-11-13"]]],
    ["last Friday", [["2026-11-06"]]], // most recent Friday is already in last week → unambiguous
  ])("%s", (text, expected) => {
    expect(dates(text)).toEqual(expected);
  });

  it("bare weekday equal to today is ambiguous (today or a week ago)", () => {
    const m = r("on Wednesday we talked about Neon").mentions[0]!;
    expect(m.ambiguous).toBe(true);
    expect(m.candidates.map((c) => c.from)).toEqual(["2026-11-11", "2026-11-04"]);
  });

  it("ignores 'next <weekday>'", () => {
    expect(dates("remind me next Tuesday")).toEqual([]);
  });

  it("uses the user's timezone for 'today'", () => {
    // 23:30 UTC on 11 Nov is already Thu 12 Nov in Tokyo.
    expect(dates("yesterday", new Date("2026-11-11T23:30:00Z"), "Asia/Tokyo")).toEqual([["2026-11-11"]]);
    expect(dates("yesterday", new Date("2026-11-11T23:30:00Z"), "America/Los_Angeles")).toEqual([["2026-11-10"]]);
  });
});

describe("formatDay", () => {
  it("renders a short human label", () => {
    expect(formatDay("2026-11-03")).toBe("Tue 3 Nov 2026");
  });
});
