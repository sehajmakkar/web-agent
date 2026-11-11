/**
 * Provider-neutral model interface (ADR-017). The agent loop only ever sees these types.
 * Each provider adapter (gemini.ts now, anthropic.ts preferred later) maps them to its own SDK.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface AssistantMessage {
  role: "assistant";
  text: string;
  toolCalls?: ToolCall[];
  /** Opaque provider state that must round-trip unchanged (e.g. Gemini thoughtSignature parts). */
  providerData?: unknown;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | AssistantMessage
  | { role: "tool"; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** "none" forces a text answer (used on the final step of the loop). */
  toolMode?: "auto" | "none";
  /** Constrain the reply to JSON matching this schema (no tools allowed alongside). */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedTokens: number;
}

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; message: AssistantMessage; usage: Usage; model: string };

export interface ModelClient {
  readonly provider: string;
  readonly model: string;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export type ModelErrorKind = "quota" | "overloaded" | "timeout" | "auth" | "bad_request" | "aborted" | "unknown";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status?: number,
    readonly model?: string,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}
