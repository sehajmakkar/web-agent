import type { ModelErrorKind, Usage } from "../llm/types.js";
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
}

/** Everything the UI / CLI / eval runner can observe about a turn. */
export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; text: string; sources: Source[]; cited: number[]; metrics: TurnMetrics }
  | { type: "error"; kind: ModelErrorKind | "search" | "internal"; message: string };
