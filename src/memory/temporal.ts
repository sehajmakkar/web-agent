import { localDate } from "../lib/clock.js";

/**
 * Deterministic date resolver (ADR-008). Turns "on Monday", "last Tuesday", "3 November", "since then", "last week"
 * into concrete calendar dates in the user's timezone, and flags ambiguity instead of guessing.
 *
 * Semantics are chosen for an assistant whose date questions are mostly about the PAST (memory, "changed since"):
 *  - A bare weekday ("on Monday") is the most recent past occurrence. If it's today's weekday: today OR a week ago (ambiguous).
 *  - "last <weekday>" is ambiguous when the most recent occurrence falls in the current week
 *    (said on Wed 11 Nov, "last Tuesday" = Tue 10 Nov or Tue 3 Nov). Otherwise it's that occurrence.
 *  - A day+month without a year is the most recent occurrence on or before today.
 *  - "next …" is future and ignored (not useful for memory or "since").
 * English only. Phase 0 showed every Gemini Flash model resolving "on Monday" to NEXT Monday; this is why it lives in code.
 */

export interface DateRange {
  /** Inclusive YYYY-MM-DD bounds. */
  from: string;
  to: string;
}

export interface DateMention {
  text: string;
  kind: "day" | "range";
  /** Most likely first. */
  candidates: DateRange[];
  ambiguous: boolean;
  /** "since" = lower bound for changes ("since 3 November"); "reference" = a point in time being referred to. */
  role: "reference" | "since";
  isToday: boolean;
}

export interface TemporalResult {
  today: string;
  mentions: DateMention[];
  /** "since then" / "since that": the anchor is another mention in the same message. */
  sinceThen: boolean;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_RE = "(\\d{1,2})(?:st|nd|rd|th)?";
const WEEKDAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";
const NUM_RE = "(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)";

// ---- calendar arithmetic on YYYY-MM-DD (timezone-free once "today" is known) ----

const toUtc = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const fromUtc = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (ymd: string, n: number) => fromUtc(new Date(toUtc(ymd).getTime() + n * 86_400_000));
export const weekdayOf = (ymd: string) => toUtc(ymd).getUTCDay();
/** Monday of the week containing ymd (ISO weeks). */
export const startOfWeek = (ymd: string) => addDays(ymd, -((weekdayOf(ymd) + 6) % 7));

function ymdOf(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null; // e.g. 31 November
  return fromUtc(date);
}

function lastDayOfMonth(y: number, m: number): string {
  return fromUtc(new Date(Date.UTC(y, m, 0, 12)));
}

/** Human label used in prompts and UI: "Tue 3 Nov 2026". */
export function formatDay(ymd: string): string {
  const d = toUtc(ymd);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const mon = d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  return `${wd} ${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}`;
}

export function formatRange(r: DateRange): string {
  return r.from === r.to ? formatDay(r.from) : `${formatDay(r.from)} – ${formatDay(r.to)}`;
}

// ---- resolver ----

interface Match {
  start: number;
  end: number;
  mention: Omit<DateMention, "role">;
}

const day = (ymd: string): DateRange => ({ from: ymd, to: ymd });

export function resolveDates(text: string, now: Date, tz: string): TemporalResult {
  const today = localDate(now, tz);
  const matches: Match[] = [];
  const lower = text.toLowerCase();

  const scan = (pattern: string, build: (m: RegExpExecArray) => Omit<DateMention, "role" | "text"> | null) => {
    const re = new RegExp(`\\b${pattern}\\b`, "gi");
    for (let m = re.exec(lower); m; m = re.exec(lower)) {
      const built = build(m);
      if (built) matches.push({ start: m.index, end: m.index + m[0].length, mention: { ...built, text: text.slice(m.index, m.index + m[0].length) } });
    }
  };

  const recentPast = (month: number, dayOfMonth: number, year?: number): string | null => {
    if (year) return ymdOf(year, month, dayOfMonth);
    const y = Number(today.slice(0, 4));
    const thisYear = ymdOf(y, month, dayOfMonth);
    if (thisYear && thisYear <= today) return thisYear;
    return ymdOf(y - 1, month, dayOfMonth);
  };
  const single = (ymd: string | null) => (ymd ? { kind: "day" as const, candidates: [day(ymd)], ambiguous: false, isToday: ymd === today } : null);

  // Absolute dates.
  scan("(\\d{4})-(\\d{2})-(\\d{2})", (m) => single(ymdOf(+m[1]!, +m[2]!, +m[3]!)));
  scan(`${DAY_RE}(?:\\s+of)?\\s+${MONTH_RE}(?:,?\\s+(\\d{4}))?`, (m) => single(recentPast(MONTHS[m[2]!]!, +m[1]!, m[3] ? +m[3] : undefined)));
  scan(`${MONTH_RE}\\s+${DAY_RE}(?:,?\\s+(\\d{4}))?`, (m) => single(recentPast(MONTHS[m[1]!]!, +m[2]!, m[3] ? +m[3] : undefined)));

  // Relative days.
  scan("(?:today|tonight|this morning|this afternoon|this evening)", () => single(today));
  scan("(?:the\\s+)?day before yesterday", () => single(addDays(today, -2)));
  scan("yesterday", () => single(addDays(today, -1)));
  scan(`${NUM_RE}\\s+(day|week|month)s?\\s+ago`, (m) => {
    const n = /^\d+$/.test(m[1]!) ? +m[1]! : NUMBER_WORDS[m[1]!]!;
    if (m[2] === "day") return single(addDays(today, -n));
    if (m[2] === "week") {
      const start = addDays(startOfWeek(today), -7 * n);
      return { kind: "range", candidates: [{ from: start, to: addDays(start, 6) }], ambiguous: false, isToday: false };
    }
    const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7)) - n;
    const yy = y + Math.floor((mo - 1) / 12), mm = ((((mo - 1) % 12) + 12) % 12) + 1;
    return { kind: "range", candidates: [{ from: ymdOf(yy, mm, 1)!, to: lastDayOfMonth(yy, mm) }], ambiguous: false, isToday: false };
  });

  // Weeks / months / weekends.
  scan("(?:earlier\\s+)?this week", () => ({ kind: "range", candidates: [{ from: startOfWeek(today), to: today }], ambiguous: false, isToday: false }));
  scan("last week", () => {
    const start = addDays(startOfWeek(today), -7);
    return { kind: "range", candidates: [{ from: start, to: addDays(start, 6) }], ambiguous: false, isToday: false };
  });
  scan("(?:last|this past) weekend", () => {
    const sat = addDays(today, -(((weekdayOf(today) - 6 + 7) % 7) || 7));
    return { kind: "range", candidates: [{ from: sat, to: addDays(sat, 1) }], ambiguous: false, isToday: false };
  });
  scan("this month", () => ({ kind: "range", candidates: [{ from: `${today.slice(0, 7)}-01`, to: today }], ambiguous: false, isToday: false }));
  scan("last month", () => {
    const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    const yy = m === 1 ? y - 1 : y, mm = m === 1 ? 12 : m - 1;
    return { kind: "range", candidates: [{ from: ymdOf(yy, mm, 1)!, to: lastDayOfMonth(yy, mm) }], ambiguous: false, isToday: false };
  });

  // Weekdays (must come after the patterns above so "last week" etc. win on overlap by length).
  scan(`(?:(last|this|past|this past|on)\\s+)?${WEEKDAY_RE}`, (m) => {
    const qualifier = m[1];
    const target = WEEKDAYS.indexOf(m[2]!);
    const todayDow = weekdayOf(today);
    const back = (todayDow - target + 7) % 7; // 0 when target is today's weekday
    const recent = addDays(today, -(back || 7)); // most recent strictly before today
    if (qualifier === "this") {
      const d = addDays(startOfWeek(today), (target + 6) % 7);
      return single(d);
    }
    if (qualifier === "last") {
      const inThisWeek = recent >= startOfWeek(today);
      return inThisWeek
        ? { kind: "day", candidates: [day(recent), day(addDays(recent, -7))], ambiguous: true, isToday: false }
        : single(recent);
    }
    // bare / "on" / "past"
    if (back === 0) return { kind: "day", candidates: [day(today), day(addDays(today, -7))], ambiguous: true, isToday: false };
    return single(addDays(today, -back));
  });
  // Swallow "next <weekday|week|month>" so its weekday isn't read as a past reference.
  scan(`next\\s+(?:${WEEKDAY_RE}|week|month)`, () => ({ kind: "day", candidates: [], ambiguous: false, isToday: false }));

  // Resolve overlaps: longest match wins; ties go to the earliest registered pattern.
  const chosen: Match[] = [];
  for (const m of [...matches].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (!chosen.some((c) => m.start < c.end && c.start < m.end)) chosen.push(m);
  }
  chosen.sort((a, b) => a.start - b.start);

  const mentions: DateMention[] = chosen
    .filter((m) => m.mention.candidates.length)
    .map((m) => ({
      ...m.mention,
      role: /\b(?:since|from|after)\s+(?:the\s+)?$/i.test(text.slice(Math.max(0, m.start - 12), m.start)) ? "since" : "reference",
    }));

  return { today, mentions, sinceThen: /\bsince\s+(?:then|that|that day|that time)\b/i.test(text) };
}
