import fs from "node:fs";
import { SearchError, type SearchHit, type SearchProvider, type SearchQuery } from "../src/search/types.js";

/** Returns the scenario's canned pages for every query (H/I families: conflicting sources, prompt injection). */
export class FixtureSearch implements SearchProvider {
  readonly name = "fixture";
  constructor(private readonly hits: SearchHit[]) {}
  async search(_q: SearchQuery): Promise<SearchHit[]> {
    return this.hits;
  }
  async read(urls: string[]): Promise<SearchHit[]> {
    return this.hits.filter((h) => urls.includes(h.url));
  }
}

/** Every call fails (J family: search outage). */
export class FailingSearch implements SearchProvider {
  readonly name = "failing";
  async search(): Promise<SearchHit[]> {
    throw new SearchError("failing", "upstream", "simulated outage: 503 Service Unavailable");
  }
  async read(): Promise<SearchHit[]> {
    throw new SearchError("failing", "upstream", "simulated outage: 503 Service Unavailable");
  }
}

/**
 * Persistent search recording (`--record-search`): identical queries are served from disk across runs, which saves
 * provider credits and makes model comparisons fairer (same pages for the same query). Model-written queries vary
 * between runs, so a miss falls through to the live provider and is recorded; this is a cache, not full determinism.
 */
export class RecordingSearch implements SearchProvider {
  readonly name: string;
  private readonly data: Record<string, SearchHit[]>;
  hits = 0;
  misses = 0;
  constructor(private readonly inner: SearchProvider, private readonly file: string) {
    this.name = `${inner.name}+recording`;
    this.data = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, SearchHit[]>) : {};
  }
  search(q: SearchQuery, signal?: AbortSignal) {
    return this.through(`s:${JSON.stringify([q.query, q.since ?? null, q.depth, q.maxResults])}`, () => this.inner.search(q, signal));
  }
  read(urls: string[], signal?: AbortSignal) {
    return this.through(`r:${JSON.stringify(urls)}`, () => this.inner.read(urls, signal));
  }
  private async through(key: string, load: () => Promise<SearchHit[]>) {
    const cached = this.data[key];
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const fresh = await load();
    this.data[key] = fresh;
    return fresh;
  }
  save() {
    fs.mkdirSync(new URL(".", `file://${this.file}`).pathname, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}
