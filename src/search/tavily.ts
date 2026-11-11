import { z } from "zod";
import { SearchError, postJson, type SearchHit, type SearchProvider, type SearchQuery } from "./types.js";

/** Tavily: fallback provider (ADR-004). */

const TavilySearch = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      content: z.string().nullish(),
      published_date: z.string().nullish(),
    }),
  ),
});

const TavilyExtract = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })),
});

export class TavilyProvider implements SearchProvider {
  readonly name = "tavily";
  constructor(private readonly apiKey: string) {}

  private get headers() {
    return { authorization: `Bearer ${this.apiKey}` };
  }

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    const json = await postJson(this.name, "https://api.tavily.com/search", this.headers, {
      query: q.query,
      search_depth: q.depth === "thorough" ? "advanced" : "basic",
      max_results: q.maxResults,
      ...(q.since ? { start_date: q.since } : {}),
    }, signal);
    const parsed = TavilySearch.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, "bad_response", "Unexpected Tavily response shape");
    return parsed.data.results.map((r) => ({
      url: r.url,
      title: r.title?.trim() || r.url,
      publishedAt: r.published_date ?? undefined,
      content: (r.content ?? "").trim(),
      provider: this.name,
    }));
  }

  async read(urls: string[], signal?: AbortSignal): Promise<SearchHit[]> {
    if (!urls.length) return [];
    const json = await postJson(this.name, "https://api.tavily.com/extract", this.headers, { urls }, signal);
    const parsed = TavilyExtract.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, "bad_response", "Unexpected Tavily extract shape");
    return parsed.data.results.map((r) => ({
      url: r.url,
      title: r.url,
      content: (r.raw_content ?? "").slice(0, 8000).trim(),
      provider: this.name,
    }));
  }
}
