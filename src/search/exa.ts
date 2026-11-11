import { z } from "zod";
import { SearchError, postJson, type SearchHit, type SearchProvider, type SearchQuery } from "./types.js";

/** Exa: primary provider (ADR-004). Phase 0: p50 0.7s with type "fast", primary source in top 3 for 13/14 queries. */

const ExaResults = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullish(),
      publishedDate: z.string().nullish(),
      text: z.string().nullish(),
      highlights: z.array(z.string()).nullish(),
    }),
  ),
});

export class ExaProvider implements SearchProvider {
  readonly name = "exa";
  constructor(private readonly apiKey: string) {}

  async search(q: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]> {
    const json = await postJson(this.name, "https://api.exa.ai/search", { "x-api-key": this.apiKey }, {
      query: q.query,
      type: q.depth === "thorough" ? "auto" : "fast",
      numResults: q.maxResults,
      contents: { text: { maxCharacters: 2500 } },
      ...(q.since ? { startPublishedDate: `${q.since}T00:00:00.000Z` } : {}),
    }, signal);
    return this.toHits(json);
  }

  async read(urls: string[], signal?: AbortSignal): Promise<SearchHit[]> {
    if (!urls.length) return [];
    const json = await postJson(this.name, "https://api.exa.ai/contents", { "x-api-key": this.apiKey }, {
      urls,
      text: { maxCharacters: 8000 },
      livecrawl: "always", // re-verification needs today's page, not a cached copy
    }, signal);
    return this.toHits(json);
  }

  private toHits(json: unknown): SearchHit[] {
    const parsed = ExaResults.safeParse(json);
    if (!parsed.success) throw new SearchError(this.name, "bad_response", "Unexpected Exa response shape");
    return parsed.data.results.map((r) => ({
      url: r.url,
      title: r.title?.trim() || r.url,
      publishedAt: r.publishedDate ?? undefined,
      content: (r.text ?? r.highlights?.join(" … ") ?? "").trim(),
      provider: this.name,
    }));
  }
}
