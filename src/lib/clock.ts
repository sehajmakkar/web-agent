/**
 * The ONLY place that reads wall-clock time (CLAUDE.md invariant 1).
 *
 * AGENT_NOW (ISO string) anchors the clock: time starts at AGENT_NOW when the process boots and keeps ticking,
 * so message ordering still works in a "time-travelled" demo or eval. Tests can pin it with setNow().
 */

/** Real time at which the current anchor was set (boot for AGENT_NOW, call time for setNow). */
let anchorReal = Date.now();
let anchor: number | null = parseAnchor(process.env.AGENT_NOW);

function parseAnchor(value: string | undefined): number | null {
  if (!value || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`AGENT_NOW is not a valid date: ${value}`);
  return ms;
}

export const clock = {
  now(): Date {
    return anchor === null ? new Date() : new Date(anchor + (Date.now() - anchorReal));
  },
  /** Monotonic milliseconds for measuring durations (not wall-clock). */
  perf(): number {
    return performance.now();
  },
  isOverridden(): boolean {
    return anchor !== null;
  },
};

/** Test/eval hook: pin "now" (string or Date). Pass null to return to real time. */
export function setNow(value: string | Date | null): void {
  anchor = value === null ? null : typeof value === "string" ? parseAnchor(value) : value.getTime();
  anchorReal = Date.now();
}

/** "2026-11-12" in the given IANA timezone. */
export function localDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** "Thursday, 12 November 2026, 10:04" in the given IANA timezone. */
export function describeDateTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
