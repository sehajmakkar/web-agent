import { describe, expect, it } from "vitest";
import type { SearchHit, SearchProvider, SearchQuery } from "../src/search/types.js";
import { SourceRegistry } from "../src/tools/sources.js";
import { runWebSearch } from "../src/tools/webSearch.js";

class FakeSearch implements SearchProvider {
  readonly name = "fake";
  readonly queries: SearchQuery[] = [];
  constructor(private readonly fail: string[] = []) {}
  async search(q: SearchQuery): Promise<SearchHit[]> {
    this.queries.push(q);
    if (this.fail.includes(q.query)) throw new Error("upstream down");
    return [{ url: `https://example.com/${encodeURIComponent(q.query)}`, title: q.query, content: `about ${q.query}`, provider: this.name }];
  }
  async read(urls: string[]): Promise<SearchHit[]> {
    return urls.map((url) => ({ url, title: "Pricing", content: "Pro $25/mo", provider: this.name }));
  }
}

describe("runWebSearch", () => {
  it("runs all queries, numbers sources, wraps content as untrusted", async () => {
    const search = new FakeSearch();
    const registry = new SourceRegistry();
    const r = await runWebSearch("c1", { queries: ["neon pricing", "supabase pricing"], urls: ["https://supabase.com/pricing"] }, { search, registry });
    expect(search.queries.map((q) => q.query)).toEqual(["neon pricing", "supabase pricing"]);
    expect(registry.list()).toHaveLength(3);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("<untrusted_web_content>");
    expect(r.content).toMatch(/\[1\] Pricing/); // live reads come first
  });

  it("code-owned since overrides the model (ADR-018) and adds an unfiltered 'current pages' search (ADR-023)", async () => {
    const search = new FakeSearch();
    await runWebSearch("c1", { queries: ["x"], since: "2020-01-01" }, { search, registry: new SourceRegistry(), forcedSince: "2026-11-03" });
    expect(search.queries.map((q) => q.since)).toEqual(["2026-11-03", undefined]);
  });

  it("labels pre-window results as background, not changes", async () => {
    const search: SearchProvider = {
      name: "fake",
      search: async () => [{ url: "https://x.com/old", title: "Old news", publishedAt: "2026-09-18", content: "old", provider: "fake" }],
      read: async () => [],
    };
    const r = await runWebSearch("c1", { queries: ["x"] }, { search, registry: new SourceRegistry(), forcedSince: "2026-11-01" });
    expect(r.content).toContain("2026-09-18 (BEFORE WINDOW 2026-11-01: background, not a change)");
  });

  it("reports partial failures without failing the call", async () => {
    const r = await runWebSearch("c1", { queries: ["ok", "bad"] }, { search: new FakeSearch(["bad"]), registry: new SourceRegistry() });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("“bad”: upstream down");
  });

  it("rejects calls with nothing to do", async () => {
    const r = await runWebSearch("c1", {}, { search: new FakeSearch(), registry: new SourceRegistry() });
    expect(r.isError).toBe(true);
  });
});
