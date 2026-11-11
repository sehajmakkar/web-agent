import { describeDateTime, localDate } from "../lib/clock.js";
import type { ChatMessage } from "../llm/types.js";
import { SYSTEM_PROMPT } from "./prompts/system.js";

/**
 * ALL model input is assembled here (CLAUDE.md invariant 2).
 *
 * Layout (ADR-010): [static system prompt + tools] → stored history → current user message + <turn_context>.
 * The turn context is attached only to the request copy of the current message and is never persisted,
 * so the history prefix stays byte-stable for prompt caching.
 */

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TurnContextInput {
  now: Date;
  tz: string;
  /** Resolved dates and the search window (from planMemory). */
  extra?: string[];
  /** The rendered <memory> block (coverage, index, recalled conversations). */
  memory?: string;
  /** ADR-027: live re-reads of previously cited pages, fetched by code before the model ran. */
  prefetched?: string;
}

export function buildTurnContext({ now, tz, extra = [], memory, prefetched }: TurnContextInput): string {
  const lines = [
    `now: ${describeDateTime(now, tz)} (${tz})`,
    `today: ${localDate(now, tz)}`,
    ...extra,
  ];
  return [
    `<turn_context>\n${lines.join("\n")}\n</turn_context>`,
    memory,
    prefetched ? `<prefetched_pages>\nThe pages cited back then, re-read live just now by the system (cite them by number).\n${prefetched}\n</prefetched_pages>` : undefined,
  ].filter(Boolean).join("\n");
}

export function buildRequest(input: { history: HistoryMessage[]; userText: string; turnContext: string }): {
  system: string;
  messages: ChatMessage[];
} {
  const turns = [...input.history.filter((m) => m.content.trim()), { role: "user" as const, content: input.userText }];
  // Merge consecutive same-role turns (e.g. a question whose answer failed is kept in history, then re-asked).
  const merged: HistoryMessage[] = [];
  for (const t of turns) {
    const prev = merged.at(-1);
    if (prev && prev.role === t.role) prev.content = `${prev.content}\n\n${t.content}`;
    else merged.push({ ...t });
  }
  const messages: ChatMessage[] = merged.map((m, i) => {
    if (m.role === "assistant") return { role: "assistant", text: m.content };
    const isCurrent = i === merged.length - 1;
    return { role: "user", text: isCurrent ? `${m.content}\n\n${input.turnContext}` : m.content };
  });
  return { system: SYSTEM_PROMPT, messages };
}
