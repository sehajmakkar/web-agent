export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "2026-11-03" → "Tue 3 Nov" (dates are calendar dates; render them in UTC so they never shift). */
export function shortDay(ymd: string): string {
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const mon = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${wd} ${d.getUTCDate()} ${mon}`;
}

export const seconds = (ms: number | null | undefined) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)}s`);
