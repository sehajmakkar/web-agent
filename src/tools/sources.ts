import type { SearchHit } from "../search/types.js";

export interface Source {
  /** Citation number the model uses: [n]. Stable within a turn. */
  n: number;
  url: string;
  title: string;
  publishedAt?: string;
  provider: string;
  /** Excerpt as shown to the model (also what the evidence ledger will store in Phase 4). */
  excerpt: string;
}

/** Normalise for dedupe: drop protocol, "www.", hash, trailing slash and common tracking params. */
export function normaliseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_src$|fbclid$|gclid$)/.test(k)) u.searchParams.delete(k);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`.toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

/** Numbers sources across every search in a turn, so [n] means the same page in the whole answer. */
export class SourceRegistry {
  private readonly byKey = new Map<string, Source>();

  add(hit: SearchHit, excerpt: string): Source {
    const key = normaliseUrl(hit.url);
    const existing = this.byKey.get(key);
    if (existing) {
      // Keep the richer excerpt (e.g. a live re-read beats a search snippet).
      if (excerpt.length > existing.excerpt.length) existing.excerpt = excerpt;
      existing.publishedAt ??= hit.publishedAt;
      return existing;
    }
    const source: Source = {
      n: this.byKey.size + 1,
      url: hit.url,
      title: hit.title,
      publishedAt: hit.publishedAt,
      provider: hit.provider,
      excerpt,
    };
    this.byKey.set(key, source);
    return source;
  }

  list(): Source[] {
    return [...this.byKey.values()].sort((a, b) => a.n - b.n);
  }

  has(n: number): boolean {
    return n >= 1 && n <= this.byKey.size;
  }
}

/**
 * Remove citations that don't point at a real source (ADR-014) and report which ones were used.
 * Handles "[3]" and grouped "[1, 4]" forms; leaves markdown links "[text](url)" alone.
 */
export function validateCitations(text: string, isValid: (n: number) => boolean): { text: string; cited: number[]; dropped: number[] } {
  const cited = new Set<number>();
  const dropped = new Set<number>();
  const out = text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_m, group: string) => {
    const nums = group.split(",").map((s) => Number(s.trim()));
    const ok = nums.filter((n) => {
      const valid = isValid(n);
      (valid ? cited : dropped).add(n);
      return valid;
    });
    return ok.length ? ok.map((n) => `[${n}]`).join("") : "";
  });
  // Pseudo-citations the model sometimes invents ("[memory]", "[source]") aren't links to anything: drop them.
  const cleaned = out.replace(/\s?\[(?:memory|source|sources|citation|ref)\](?!\()/gi, "");
  return { text: cleaned.replace(/[ \t]+([.,;:!?])/g, "$1"), cited: [...cited].sort((a, b) => a - b), dropped: [...dropped] };
}
