import { localDate } from "../lib/clock.js";
import type { Conversation, Store, StoredMessage } from "./store.js";
import { addDays, formatDay, formatRange, resolveDates, type DateMention, type DateRange, type TemporalResult } from "./temporal.js";

/**
 * Memory planning for one turn: pure code, no model call, ~ms (ADR-005 option A: memory is context, not a tool).
 *
 *   resolve dates → find conversations in those windows → settle ambiguity by topic → digest them
 *   → decide the code-owned `since` for web_search (ADR-018) → render the <memory> block with an explicit coverage
 *   statement, so the model can say "I have no record of that" instead of inventing one (C2).
 */

export interface MemoryPlan {
  temporal: TemporalResult;
  /** Lines for <turn_context> (dates, search window). */
  contextLines: string[];
  /** The <memory> block appended after <turn_context>. */
  memoryBlock: string;
  /** Code-owned lower bound for web_search this turn. */
  since?: string;
  /** ADR-027: pages recorded/cited back then that the loop re-reads BEFORE the model runs (change questions only). */
  verifyUrls: string[];
  trace: MemoryTrace;
}

const MAX_VERIFY_URLS = 5;

export interface MemoryTrace {
  memoryIntent: boolean;
  changeIntent: boolean;
  keywords: string[];
  dates: { text: string; candidates: string[]; resolved: string | null; ambiguous: boolean; how?: string }[];
  recalled: { id: string; title: string; localDate: string; why: string }[];
  since?: string;
  sinceReason?: string;
  coverage: { count: number; first?: string; last?: string };
}

const MEMORY_INTENT =
  /\b(i|we)\s+(asked|said|told|mentioned|discussed|talked|chatted|compared|shortlisted|picked|chose|decided|looked)\b|\byou\s+(said|told|recommended|suggested|answered|mentioned|gave|showed)\b|\b(what|which)\s+did\s+(i|we|you)\b|\blast time\b|\bearlier\b|\bpreviously\b|\bbefore\b.*\b(asked|discussed)\b|\bour (chat|conversation|discussion)\b|\bremind me\b|\byour (answer|recommendation|advice)\b/i;
const CHANGE_INTENT =
  /\b(chang\w*|still (correct|true|accurate|valid|right|the case|current)|updat\w*|anything new|what'?s new|new (features?|pricing|plans?|releases?)|since|shipped|launch\w*|announc\w*|different now|any news|moved|raised|cut|dropped)\b/i;

const STOPWORDS = new Set(
  ("a an the and or but if then than so to of in on at by for with from about into over after before since until as is are was were be been being am " +
    "do does did done have has had having i me my we our us you your it its this that these those there here what which who whom whose when where why how " +
    "any some all each every no not only also just very can could would should will shall may might must " +
    "ask asked asking tell told say said discuss discussed talk talked chat chatted mention mentioned compare compared shortlisted shortlist picked chose decided " +
    "remember remind last time earlier previously again still correct true today yesterday tomorrow week month year ago now then currently " +
    "change changed changes changing update updated new anything something big ship shipped since " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec answer question thing things one lot please thanks hey hi").split(/\s+/),
);

const INDEX_DAYS = 30;
const INDEX_MAX = 20;
const MAX_RECALLED = 4;
const MSG_CHARS_USER = 400;
const MSG_CHARS_ASSISTANT = 1_500;

export function extractKeywords(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+(st|nd|rd|th)?$/.test(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Crude stem so "shortlisted"≈"shortlist", "prices"≈"price". */
const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "");

function topicScore(conv: Conversation, messages: StoredMessage[], keywords: string[]): number {
  if (!keywords.length) return 0;
  const strong = `${conv.title} ${conv.topics.join(" ")}`.toLowerCase();
  const body = messages.map((m) => m.content).join(" ").toLowerCase();
  let score = 0;
  for (const k of keywords) {
    const s = stem(k);
    if (strong.includes(s)) score += 2;
    else if (body.includes(s)) score += 1;
  }
  return score;
}

export function planMemory(
  store: Store | undefined,
  input: { text: string; now: Date; tz: string; excludeConversationId?: string },
): MemoryPlan {
  const temporal = resolveDates(input.text, input.now, input.tz);
  const memoryIntent = MEMORY_INTENT.test(input.text);
  const changeIntent = CHANGE_INTENT.test(input.text);
  const keywords = extractKeywords(input.text);
  const exclude = input.excludeConversationId;
  const coverage = store ? store.coverage(exclude) : { count: 0 };

  const trace: MemoryTrace = { memoryIntent, changeIntent, keywords, dates: [], recalled: [], coverage };
  const recalled = new Map<string, { conv: Conversation; why: string }>();
  const messagesCache = new Map<string, StoredMessage[]>();
  const messagesOf = (id: string) => {
    if (!messagesCache.has(id)) messagesCache.set(id, store!.getMessages(id));
    return messagesCache.get(id)!;
  };

  // Past mentions only ("today" is the present, not a memory window, unless it's the only date).
  const pastMentions = temporal.mentions.filter((m) => !m.isToday);
  const resolvedByMention = new Map<DateMention, DateRange | null>();

  for (const mention of temporal.mentions) {
    const entry: MemoryTrace["dates"][number] = {
      text: mention.text,
      candidates: mention.candidates.map((c) => formatRange(c)),
      resolved: mention.ambiguous ? null : formatRange(mention.candidates[0]!),
      ambiguous: mention.ambiguous,
    };
    let resolved: DateRange | null = mention.ambiguous ? null : mention.candidates[0]!;

    if (store && !mention.isToday && (memoryIntent || mention.ambiguous)) {
      const perCandidate = mention.candidates.map((range) => {
        const convs = store.conversationsInRange(range.from, range.to, exclude);
        const scored = convs.map((c) => ({ conv: c, score: topicScore(c, messagesOf(c.id), keywords) }));
        return { range, scored, best: Math.max(0, ...scored.map((s) => s.score)) };
      });

      if (mention.ambiguous) {
        const withTopic = perCandidate.filter((p) => p.best > 0);
        const withAny = perCandidate.filter((p) => p.scored.length > 0);
        if (keywords.length && withTopic.length === 1) {
          resolved = withTopic[0]!.range;
          entry.how = `only ${formatRange(resolved)} has a conversation matching ${JSON.stringify(keywords.join(" "))}`;
        } else if (!withTopic.length && withAny.length === 1) {
          resolved = withAny[0]!.range;
          entry.how = `only ${formatRange(resolved)} has any conversation`;
        } else {
          entry.how = withTopic.length > 1 ? "several candidate dates match the topic" : "no candidate date has a matching conversation";
        }
        entry.resolved = resolved ? formatRange(resolved) : null;
      }

      if (memoryIntent) {
        const windows = resolved ? perCandidate.filter((p) => p.range === resolved) : perCandidate;
        for (const w of windows) {
          const ranked = [...w.scored].sort((a, b) => b.score - a.score);
          // On a resolved date with a clear topic, keep the matching conversations; otherwise everything that day.
          const keep = keywords.length && w.best > 0 ? ranked.filter((s) => s.score > 0) : ranked;
          for (const s of keep) {
            if (!recalled.has(s.conv.id)) recalled.set(s.conv.id, { conv: s.conv, why: `${mention.text} → ${formatRange(w.range)}` });
          }
        }
      }
    }
    resolvedByMention.set(mention, resolved);
    trace.dates.push(entry);
  }

  // Memory reference without a usable date ("last time I asked about Postgres"): full-text search.
  if (store && memoryIntent && !pastMentions.length && keywords.length) {
    for (const hit of store.searchConversations(keywords, 3, exclude)) {
      const conv = store.getConversation(hit.conversationId);
      if (conv && !recalled.has(conv.id)) recalled.set(conv.id, { conv, why: `matches ${JSON.stringify(keywords.join(" "))}` });
    }
  }

  // Even without explicit memory intent, surface a strongly related past conversation ("remembers you").
  if (store && !memoryIntent && keywords.length >= 2) {
    for (const hit of store.searchConversations(keywords, 3, exclude)) {
      const conv = store.getConversation(hit.conversationId);
      if (!conv || recalled.has(conv.id)) continue;
      const strong = `${conv.title} ${conv.topics.join(" ")}`.toLowerCase();
      const strongHits = keywords.filter((k) => strong.includes(stem(k))).length;
      if (strongHits >= 2) recalled.set(conv.id, { conv, why: "possibly related (topic match)" });
    }
  }

  // ---- `since` (ADR-018) ----
  let since: string | undefined;
  let sinceReason: string | undefined;
  const sinceMention = temporal.mentions.find((m) => m.role === "since");
  const firstRecalledDate = [...recalled.values()].map((r) => r.conv.localDate).sort()[0];
  const earliestOf = (m: DateMention) => (resolvedByMention.get(m) ?? m.candidates.at(-1)!).from;
  if (sinceMention) {
    since = earliestOf(sinceMention);
    sinceReason = `"${sinceMention.text}"${resolvedByMention.get(sinceMention) ? "" : " (ambiguous: earliest candidate, to be safe)"}`;
  } else if (changeIntent && pastMentions.length) {
    const anchor = pastMentions[0]!;
    since = earliestOf(anchor);
    sinceReason = `change question about "${anchor.text}"${resolvedByMention.get(anchor) ? "" : " (ambiguous: earliest candidate)"}`;
  } else if (changeIntent && memoryIntent && firstRecalledDate) {
    since = firstRecalledDate;
    sinceReason = "change question about a recalled conversation";
  }
  trace.since = since;
  trace.sinceReason = sinceReason;
  trace.recalled = [...recalled.values()].slice(0, MAX_RECALLED).map((r) => ({ id: r.conv.id, title: r.conv.title, localDate: r.conv.localDate, why: r.why }));

  // ---- render ----
  const contextLines: string[] = [];
  if (temporal.mentions.length) {
    contextLines.push("dates_in_message (resolved by code, trust these):");
    for (const d of trace.dates) {
      const line = d.ambiguous
        ? d.resolved
          ? `- "${d.text}" → ${d.resolved} (ambiguous between ${d.candidates.join(" / ")}; resolved because ${d.how})`
          : `- "${d.text}" → AMBIGUOUS: ${d.candidates.join(" or ")} (${d.how ?? "no memory to disambiguate"})`
        : `- "${d.text}" → ${d.resolved}`;
      contextLines.push(line);
    }
    if (temporal.sinceThen) contextLines.push(`- "since then" refers to the date above`);
  }
  if (since) contextLines.push(`search_window: changes on/after ${formatDay(since)} (applied automatically to every web_search this turn)`);

  // ADR-027: on change questions, the code knows exactly which pages to re-check: claim sources first, then other cited pages.
  const verifyUrls: string[] = [];
  if (store && changeIntent) {
    const seen = new Set<string>();
    const push = (url?: string) => {
      if (!url || verifyUrls.length >= MAX_VERIFY_URLS) return;
      const key = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[/#?]+$/, "").toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      verifyUrls.push(url);
    };
    const kept = [...recalled.values()].slice(0, MAX_RECALLED);
    for (const { conv } of kept) for (const c of store.evidence(conv.id).claims) push(c.url);
    for (const { conv } of kept) for (const m of messagesOf(conv.id)) for (const s of m.sources) if (s.cited) push(s.url);
  }

  const memoryBlock = renderMemory(store, { coverage, trace, recalled: [...recalled.values()].slice(0, MAX_RECALLED), messagesOf, input, exclude });
  return { temporal, contextLines, memoryBlock, since, verifyUrls, trace };
}

function renderMemory(
  store: Store | undefined,
  ctx: {
    coverage: MemoryTrace["coverage"];
    trace: MemoryTrace;
    recalled: { conv: Conversation; why: string }[];
    messagesOf: (id: string) => StoredMessage[];
    input: { now: Date; tz: string };
    exclude?: string;
  },
): string {
  const lines: string[] = ["<memory>"];
  const { coverage } = ctx;
  const noRecord = ctx.trace.memoryIntent && !ctx.recalled.length;
  if (!store || coverage.count === 0) {
    lines.push("coverage: NO earlier conversations are recorded. This is the first conversation. Anything the user says you discussed before is not in your memory.");
  } else {
    lines.push(
      `coverage: ${coverage.count} earlier conversation(s) recorded, from ${formatDay(coverage.first!)} to ${formatDay(coverage.last!)}. ` +
        "This is the complete record: if something isn't listed here, it did not happen in a recorded conversation.",
    );
    const today = localDate(ctx.input.now, ctx.input.tz);
    const index = store.recentConversations(addDays(today, -INDEX_DAYS), INDEX_MAX, ctx.exclude);
    if (index.length) {
      lines.push("", `recent_conversations (last ${INDEX_DAYS} days, newest first):`);
      for (const c of index) lines.push(`- ${formatDay(c.localDate)} · ${c.title || "Untitled"}${c.topics.length ? ` [${c.topics.slice(0, 6).join(", ")}]` : ""}`);
    }
  }

  if (noRecord && store && coverage.count > 0) {
    lines.push("", "recalled: NOTHING matches what the user is referring to. Say so plainly before anything else; do not guess what was said.");
  }
  // ADR-019, decided in code (Phase 3: Flash-Lite only asked, even with the rule in the system prompt).
  if (noRecord) {
    const checkable = ctx.trace.changeIntent && ctx.trace.keywords.length > 0;
    lines.push(
      "",
      checkable
        ? "no_record_policy: PROCEED. Call web_search NOW for the most likely items given the user's own context (e.g. team size, use case). " +
            "Your FINAL answer (written after the results; earlier text is discarded) must start with one sentence saying you have no record of " +
            "that conversation, then name the items as your assumption, then the findings, then invite the user to correct the list. Do not stop at asking."
        : "no_record_policy: say you have no record of it (and what your history covers), then offer the concrete next step " +
            "(e.g. \"paste what I said and I'll re-check it\"). Don't search or guess.",
    );
  }

  for (const { conv, why } of ctx.recalled) {
    lines.push("", `## Recalled conversation (${why})`, `### ${formatDay(conv.localDate)} · "${conv.title || "Untitled"}"`);
    const messages = ctx.messagesOf(conv.id);
    for (const m of messages.slice(-8)) {
      const time = new Date(m.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ctx.input.tz });
      const limit = m.role === "user" ? MSG_CHARS_USER : MSG_CHARS_ASSISTANT;
      const body = m.content.length > limit ? `${m.content.slice(0, limit)}…` : m.content;
      lines.push(`[${time}] ${m.role === "user" ? "User" : "You"}: ${body.replace(/\n+/g, " ")}`);
      const cited = m.sources.filter((s) => s.cited);
      if (cited.length) lines.push(`  sources cited then: ${cited.map((s) => `[${s.n}] ${s.url}`).join(" · ")}`);
    }
    const ev = store!.evidence(conv.id);
    if (ev.claims.length) {
      lines.push("  claims recorded then (verify these against today's sources):");
      for (const c of ev.claims) lines.push(`  - ${c.entity} · ${c.attribute}: ${c.value}${c.url ? ` (source: ${c.url})` : ""}, observed ${formatDay(c.observedAt.slice(0, 10))}`);
    }
    for (const n of ev.notes) lines.push(`  user decision recorded (${n.kind}): ${JSON.stringify(n.payload)}`);
  }

  // Change questions get an explicit checklist: the "then" side comes from the ledger, verbatim. Phase 3 caught
  // Flash-Lite rewriting the old value from today's page ("then: ~$15/mo" when $19/mo was recorded) and so missing the change.
  if (ctx.trace.changeIntent && store) {
    const items: string[] = [];
    const days = new Set<string>();
    let claimItems = 0;
    let decisionItems = 0;
    for (const { conv } of ctx.recalled) {
      const ev = store.evidence(conv.id);
      for (const c of ev.claims) {
        days.add(formatDay(c.observedAt.slice(0, 10)));
        claimItems++;
        items.push(`${items.length + 1}. ${c.entity}, ${c.attribute}: recorded "${c.value}" on ${formatDay(c.observedAt.slice(0, 10))}${c.url ? ` (source then: ${c.url})` : ""}`);
      }
      for (const n of ev.notes) {
        const p = n.payload as { items?: unknown[]; subject?: string };
        if (!Array.isArray(p.items)) continue;
        days.add(formatDay(conv.localDate));
        for (const it of p.items) {
          decisionItems++;
          items.push(`${items.length + 1}. ${String(it)}${p.subject ? ` (${p.subject})` : ""}: pricing change or major launch since ${formatDay(conv.localDate)}?`);
        }
      }
    }
    if (items.length) {
      // The table shape follows what was actually recorded: a "Then" column only exists if we recorded values.
      // (Phase 3: forcing "Then" on a shortlist made the model fill it from today's pages.)
      const shape = claimItems
        ? "a table with columns Item | Then (recorded) | Now (with [n]) | Verdict (Changed / No change found / Couldn't verify)"
        : `a table with columns Item | What's new since ${[...days][0]} (dated, with [n]) | Verdict (Pricing change / Major launch / Nothing notable found / Couldn't verify). ` +
          "No 'then' column: no prices were recorded. Minor feature tweaks are 'Nothing notable'.";
      lines.push(
        "",
        `verification_checklist: answer EVERY item.${claimItems ? " Recorded values are the 'then' side: copy them exactly, never restate them from today's pages." : ""}`,
        ...items,
        `answer_shape: one opening sentence naming the date (${[...days].join(", ")}) and what was discussed; then ${shape}; then at most two lines on what matters most.` +
          (decisionItems && claimItems ? " Put recorded-value items and decision items in separate tables." : ""),
      );
    }
  }
  lines.push("</memory>");
  return lines.join("\n");
}
