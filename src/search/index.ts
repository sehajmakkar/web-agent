import type { Config } from "../lib/config.js";
import { ExaProvider } from "./exa.js";
import { TavilyProvider } from "./tavily.js";
import type { SearchHit, SearchProvider, SearchQuery } from "./types.js";

/** Try providers in order; first success wins. Errors are collected and rethrown only if all fail. */
export class FallbackSearch implements SearchProvider {
  readonly name: string;
  constructor(private readonly providers: SearchProvider[]) {
    if (!providers.length) throw new Error("FallbackSearch needs at least one provider");
    this.name = providers.map((p) => p.name).join("→");
  }

  search(q: SearchQuery, signal?: AbortSignal) {
    return this.tryEach((p) => p.search(q, signal));
  }

  read(urls: string[], signal?: AbortSignal) {
    return this.tryEach((p) => p.read(urls, signal));
  }

  private async tryEach(fn: (p: SearchProvider) => Promise<SearchHit[]>): Promise<SearchHit[]> {
    const errors: unknown[] = [];
    for (const p of this.providers) {
      try {
        return await fn(p);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        errors.push(err);
      }
    }
    throw errors.length === 1 ? errors[0] : new AggregateError(errors, errors.map(String).join(" | "));
  }
}

/** Short-TTL in-memory cache: repeated queries (follow-ups, evals, demos) return instantly. */
export class CachedSearch implements SearchProvider {
  readonly name: string;
  private readonly store = new Map<string, { at: number; hits: SearchHit[] }>();
  constructor(private readonly inner: SearchProvider, private readonly ttlMs = 10 * 60_000) {
    this.name = inner.name;
  }

  search(q: SearchQuery, signal?: AbortSignal) {
    return this.cached(`s:${JSON.stringify(q)}`, () => this.inner.search(q, signal));
  }

  // Reads are re-verification: never cache them for long.
  read(urls: string[], signal?: AbortSignal) {
    return this.cached(`r:${urls.join("|")}`, () => this.inner.read(urls, signal), 60_000);
  }

  private async cached(key: string, load: () => Promise<SearchHit[]>, ttl = this.ttlMs) {
    const hit = this.store.get(key);
    if (hit && performance.now() - hit.at < ttl) return hit.hits;
    const hits = await load();
    this.store.set(key, { at: performance.now(), hits });
    return hits;
  }
}

export function createSearch(config: Config): SearchProvider {
  const providers: SearchProvider[] = [];
  if (config.EXA_API_KEY) providers.push(new ExaProvider(config.EXA_API_KEY));
  if (config.TAVILY_API_KEY) providers.push(new TavilyProvider(config.TAVILY_API_KEY));
  return new CachedSearch(new FallbackSearch(providers));
}

export * from "./types.js";
