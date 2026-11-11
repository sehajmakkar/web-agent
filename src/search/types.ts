export interface SearchQuery {
  query: string;
  /** ISO date (YYYY-MM-DD): only results published on/after this date. */
  since?: string;
  depth: "fast" | "thorough";
  maxResults: number;
}

export interface SearchHit {
  url: string;
  title: string;
  /** ISO date if the provider knows it. Many pages (pricing!) have none. */
  publishedAt?: string;
  content: string;
  provider: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: SearchQuery, signal?: AbortSignal): Promise<SearchHit[]>;
  /** Fetch the live content of known URLs (re-verification of cited pages). */
  read(urls: string[], signal?: AbortSignal): Promise<SearchHit[]>;
}

export class SearchError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: "quota" | "auth" | "timeout" | "upstream" | "bad_response",
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

/** Shared HTTP helper: JSON POST with timeout and typed errors. */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw new SearchError(provider, "timeout", `${provider} timed out`);
    throw err;
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const kind = res.status === 429 || res.status === 402 || res.status === 432 ? "quota" : res.status === 401 || res.status === 403 ? "auth" : "upstream";
    throw new SearchError(provider, kind, `${provider} ${res.status}: ${text}`, res.status);
  }
  return res.json();
}
