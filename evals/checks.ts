/**
 * Deterministic checks for eval scenarios (docs/EVALS.md). Behavioural, not exact-match: the web changes, so we check
 * WHAT the agent did (dates resolved, memory used, window applied, honesty), not the exact words.
 * Text heuristics are deliberately simple and named so a failure is easy to read.
 */
import type { TurnMetrics } from "../src/agent/types.js";
import { formatDay } from "../src/memory/temporal.js";
import type { Source } from "../src/tools/sources.js";

export interface TurnOutcome {
  text: string;
  sources: Source[];
  cited: number[];
  metrics?: TurnMetrics;
  error?: { kind: string; message: string };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

type Expect = Record<string, unknown>;

const lc = (s: string) => s.toLowerCase();
const day = (ymd: string) => formatDay(String(ymd).slice(0, 10));
/** "3 Nov", "3 November", "November 3", "Nov 3" for a YYYY-MM-DD. */
function mentionsDate(text: string, ymd: string): boolean {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`);
  const n = d.getUTCDate();
  const mon = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });
  return new RegExp(`\\b${n}(st|nd|rd|th)?\\s+(${mon}|${month})\\b|\\b(${mon}|${month})\\.?\\s+${n}(st|nd|rd|th)?\\b`, "i").test(text);
}

export const PATTERNS = {
  noRecord: /(don[’']?t|do not) have (a |any )?(record|memory)|no record|no (earlier|previous|prior|recorded) (conversation|chat)|(history|memory) (starts|begins)/i,
  invented: /\b(you asked( me)? (about|whether|for|if)|we (discussed|compared|talked about)|you (told|mentioned to) me)\b/i,
  assumption: /\bassum|if your (list|shortlist|five|tools)|most likely|my best guess|i'?ll (assume|use|check) (the )?(common|popular|usual)/i,
  invitesCorrection: /(let me know|tell me|if your .{0,40}(was|were|is) different|correct (me|the list)|which (ones|tools|providers))/i,
  failure: /(couldn[’']?t|could not|unable to|wasn[’']?t able to|can[’']?t|cannot) (reach|search|verify|access|retrieve|look up|check|get)|search (failed|is (currently )?unavailable|isn[’']?t working)|(search|web) (results )?(are|is) (currently )?(unavailable|down)/i,
  question: /\?\s*$/,
};

/** Evaluate one turn's expectations. `isCold` = the scenario has no seeded history. */
export function runChecks(expect: Expect, out: TurnOutcome, ctx: { isCold: boolean }): CheckResult[] {
  const results: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail?: string) => results.push({ name, pass, detail });
  const text = out.text ?? "";
  const m = out.metrics;
  const dates = m?.memory?.dates ?? [];
  const searches = m?.searches ?? [];

  if (out.error) add("no_error", false, `${out.error.kind}: ${out.error.message}`);

  for (const [key, value] of Object.entries(expect)) {
    switch (key) {
      case "resolved_dates": {
        const want = (value as string[]).map(day);
        const got = dates.flatMap((d) => (d.resolved ? [d.resolved] : d.candidates));
        add(key, want.every((w) => got.includes(w)), `want ${want.join(", ")}; got ${got.join(", ") || "none"}`);
        break;
      }
      case "resolved_candidates": {
        const want = (value as string[]).map(day);
        const amb = dates.find((d) => d.ambiguous);
        add(key, Boolean(amb) && want.every((w) => amb!.candidates.includes(w)), `got ${amb?.candidates.join(" / ") ?? "no ambiguous date"}`);
        break;
      }
      case "picks_date": {
        const want = day(value as string);
        add(key, dates.some((d) => d.resolved === want), `got ${dates.map((d) => d.resolved).join(", ")}`);
        break;
      }
      case "states_date":
        add(key, !value || dates.some((d) => d.resolved && mentionsDate(text, isoOf(d.resolved))), "answer names the resolved date");
        break;
      case "asks_clarification": {
        const asks = PATTERNS.question.test(text.trim()) && text.length < 500;
        add(key, asks === value, asks ? "answer is a short question" : "answer proceeds");
        break;
      }
      case "handles_ambiguity": {
        const both = mentionsDate(text, "2026-11-03") && mentionsDate(text, "2026-11-10");
        const asks = PATTERNS.question.test(text.trim());
        add(key, both || asks, both ? "covers both dates" : asks ? "asks which" : "picked one silently");
        break;
      }
      case "mentions_all": {
        const missing = (value as string[]).filter((s) => !lc(text).includes(lc(s)));
        add(key, !missing.length, missing.length ? `missing: ${missing.join(", ")}` : undefined);
        break;
      }
      case "mentions_any":
        add(key, (value as string[]).some((s) => lc(text).includes(lc(s))));
        break;
      case "mentions_none": {
        const found = (value as string[]).filter((s) => lc(text).includes(lc(s)));
        add(key, !found.length, found.length ? `found: ${found.join(", ")}` : undefined);
        break;
      }
      case "mentions_none_as_shortlisted": {
        const rows = text.split("\n").filter((l) => /^\s*\|/.test(l));
        const bad = (value as string[]).filter((s) => rows.some((r) => new RegExp(`^\\s*\\|\\s*\\**${s}`, "i").test(r)));
        add(key, !bad.length, bad.length ? `listed as an item: ${bad.join(", ")}` : undefined);
        break;
      }
      case "web_search": {
        const w = value as { min_calls?: number; max_calls?: number; since?: string; rereads_any?: string[]; min_queries?: number };
        const calls = searches.length;
        const queries = searches.reduce((a, s) => a + s.queries.length, 0);
        if (w.min_calls !== undefined) add("web_search.min_calls", calls >= w.min_calls, `${calls} call(s)`);
        if (w.max_calls !== undefined) add("web_search.max_calls", calls <= w.max_calls, `${calls} call(s)`);
        if (w.min_queries !== undefined) add("web_search.min_queries", queries >= w.min_queries, `${queries} queries`);
        if (w.since !== undefined) {
          const want = String(w.since).slice(0, 10);
          add("web_search.since", calls > 0 && searches.every((s) => s.since === want), `since: ${searches.map((s) => s.since ?? "none").join(", ") || "no searches"}`);
        }
        if (w.rereads_any) {
          const urls = searches.flatMap((s) => s.urls);
          add("web_search.rereads", w.rereads_any.some((u) => urls.some((x) => x.includes(u))), `re-read: ${urls.join(", ") || "none"}`);
        }
        break;
      }
      case "cites":
        add(key, value ? out.cited.length > 0 : out.cited.length === 0, `${out.cited.length} cited`);
        break;
      case "no_citations":
        add(key, out.cited.length === 0, `${out.cited.length} cited`);
        break;
      case "shows_source_dates":
        add(key, out.sources.some((s) => out.cited.includes(s.n) && s.publishedAt) || /\b20\d\d\b/.test(text));
        break;
      case "no_invented_memory": {
        // Hard fail (C2): on a cold start, the answer must not claim past conversation content.
        const invented = ctx.isCold && PATTERNS.invented.test(text) && !PATTERNS.noRecord.test(text.slice(0, 200));
        add(key, !invented, invented ? `claims past content: "${text.match(PATTERNS.invented)?.[0]}"` : undefined);
        break;
      }
      case "states_no_record": {
        const idx = text.search(PATTERNS.noRecord);
        add(key, idx >= 0 && idx < 250, idx < 0 ? "no 'no record' statement" : idx >= 250 ? "stated, but not first" : undefined);
        break;
      }
      case "labels_assumption":
        add(key, PATTERNS.assumption.test(text));
        break;
      case "invites_correction":
        add(key, PATTERNS.invitesCorrection.test(text));
        break;
      case "admits_failure":
        add(key, PATTERNS.failure.test(text));
        break;
      case "ttft_ms_max":
        add(key, m?.ttftMs != null && m.ttftMs <= (value as number), `${m?.ttftMs ?? "–"}ms`);
        break;
      default:
        if (!/^turn\d+$/.test(key)) add(`unknown_check:${key}`, false);
    }
  }
  return results;
}

/** "Tue 3 Nov 2026" → "2026-11-03". */
function isoOf(label: string): string {
  const d = new Date(`${label.replace(/^\w+ /, "")} 12:00 UTC`);
  return Number.isNaN(d.getTime()) ? label : d.toISOString().slice(0, 10);
}

export function percentile(values: number[], p: number): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))]!;
}
