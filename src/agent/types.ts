import type { ModelErrorKind, Usage } from "../llm/types.js";
import type { MemoryTrace } from "../memory/retrieve.js";
import type { Source } from "../tools/sources.js";

export interface TurnMetrics {
  model: string;
  /** ms from turn start to the first visible answer token. */
  ttftMs: number | null;
  totalMs: number;
  steps: number;
  searchCalls: number;
  queries: number;
  usage: Usage;
  droppedCitations: number[];
  /** What memory planning decided this turn (dates, recall, window): the eval runner checks these. */
  memory: Pick<MemoryTrace, "dates" | "recalled" | "since" | "sinceReason" | "memoryIntent" | "changeIntent">;
  /** Every web_search call as executed (after the code-owned window was applied). */
  searches: { queries: string[]; urls: string[]; since?: string }[];
}

/** Everything the UI / CLI / eval runner can observe about a turn. */
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  /** Discard text streamed so far this turn: it was a pre-search draft, not the answer (ADR-024). */
  | { type: "reset" }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; text: string; sources: Source[]; cited: number[]; metrics: TurnMetrics }
  | { type: "error"; kind: ModelErrorKind | "search" | "internal"; message: string };
