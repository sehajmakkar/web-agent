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
  /** Phase 3+: resolved dates, memory digest, memory coverage. */
  extra?: string[];
}

export function buildTurnContext({ now, tz, extra = [] }: TurnContextInput): string {
  const lines = [
    `now: ${describeDateTime(now, tz)} (${tz})`,
    `today: ${localDate(now, tz)}`,
    ...extra,
  ];
  return `<turn_context>\n${lines.join("\n")}\n</turn_context>`;
}

export function buildRequest(input: { history: HistoryMessage[]; userText: string; turnContext: string }): {
  system: string;
  messages: ChatMessage[];
} {
  const messages: ChatMessage[] = input.history
    .filter((m) => m.content.trim())
    .map((m) => (m.role === "user" ? { role: "user", text: m.content } : { role: "assistant", text: m.content }));
  messages.push({ role: "user", text: `${input.userText}\n\n${input.turnContext}` });
  return { system: SYSTEM_PROMPT, messages };
}
