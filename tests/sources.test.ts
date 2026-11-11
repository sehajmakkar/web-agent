import { describe, expect, it } from "vitest";
import { SourceRegistry, normaliseUrl, validateCitations } from "../src/tools/sources.js";

const hit = (url: string, extra: Partial<{ publishedAt: string }> = {}) => ({ url, title: url, content: "x", provider: "test", ...extra });

describe("normaliseUrl", () => {
  it("treats www/trailing slash/hash/utm variants as the same page", () => {
    const a = normaliseUrl("https://www.neon.com/pricing/");
    expect(normaliseUrl("http://neon.com/pricing#plans")).toBe(a);
    expect(normaliseUrl("https://neon.com/pricing?utm_source=x")).toBe(a);
  });
  it("keeps meaningful query params", () => {
    expect(normaliseUrl("https://a.com/p?id=1")).not.toBe(normaliseUrl("https://a.com/p?id=2"));
  });
});

describe("SourceRegistry", () => {
  it("numbers sources across searches and dedupes", () => {
    const r = new SourceRegistry();
    expect(r.add(hit("https://a.com/1"), "short").n).toBe(1);
    expect(r.add(hit("https://b.com/2"), "b").n).toBe(2);
    const again = r.add(hit("https://www.a.com/1/", { publishedAt: "2026-11-01" }), "a much longer excerpt");
    expect(again.n).toBe(1);
    expect(again.excerpt).toBe("a much longer excerpt");
    expect(again.publishedAt).toBe("2026-11-01");
    expect(r.list().map((s) => s.n)).toEqual([1, 2]);
  });
});

describe("validateCitations", () => {
  const valid = (n: number) => n === 1 || n === 2;
  it("keeps valid, drops invalid, splits groups", () => {
    const out = validateCitations("Neon is $19 [1]. Supabase is $25 [2, 9]. Render is cheap [7].", valid);
    expect(out.text).toBe("Neon is $19 [1]. Supabase is $25 [2]. Render is cheap.");
    expect(out.cited).toEqual([1, 2]);
    expect(out.dropped.sort()).toEqual([7, 9]);
  });
  it("drops invented pseudo-citations like [memory]", () => {
    expect(validateCitations("On Monday we shortlisted five tools [memory]. Pro is $25 [1].", valid).text).toBe(
      "On Monday we shortlisted five tools. Pro is $25 [1].",
    );
  });
  it("does not touch markdown links", () => {
    const out = validateCitations("See [3](https://x.com) and [1].", valid);
    expect(out.text).toBe("See [3](https://x.com) and [1].");
  });
});
