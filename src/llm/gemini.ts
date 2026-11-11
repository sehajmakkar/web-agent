import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Content,
  type GenerateContentResponseUsageMetadata,
  type Part,
} from "@google/genai";
import {
  ModelError,
  emptyUsage,
  type ChatMessage,
  type ModelClient,
  type ModelEvent,
  type ModelRequest,
  type ToolCall,
  type Usage,
} from "./types.js";

/**
 * Gemini adapter. Phase 0 findings this encodes (spikes/phase0/README.md):
 *  - Gemini 3.x returns `thoughtSignature` on parts; the model turn must be sent back with its parts unchanged.
 *  - Overload (503) and timeouts are common on the free tier → try fallback models, but only before any output
 *    has streamed (otherwise the user would see two half-answers).
 *  - Quota (429) is NOT retried on another model: it surfaces as a clear error so the operator can rotate the key.
 */

const LEVELS = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} as const;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fallbackModels?: string[];
  thinkingLevel?: keyof typeof LEVELS;
  /** Abort a single model call after this long. */
  timeoutMs?: number;
}

/** Tool-call ids we invent (Gemini API usually omits ids) must not be sent back to the API. */
const LOCAL_ID_PREFIX = "local_";

export class GeminiClient implements ModelClient {
  readonly provider = "gemini";
  readonly model: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly opts: GeminiOptions) {
    this.model = opts.model;
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const models = [this.opts.model, ...(this.opts.fallbackModels ?? [])];
    let lastError: ModelError | undefined;
    for (const model of models) {
      let emitted = false;
      try {
        for await (const event of this.streamOnce(model, request)) {
          if (event.type !== "done") emitted = true;
          yield event;
        }
        return;
      } catch (err) {
        const error = toModelError(err, model);
        const retryable = error.kind === "overloaded" || error.kind === "timeout";
        if (emitted || !retryable) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new ModelError("unknown", "No model available");
  }

  private async *streamOnce(model: string, request: ModelRequest): AsyncIterable<ModelEvent> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const hasTools = Boolean(request.tools?.length);

    const response = await this.ai.models.generateContentStream({
      model,
      contents: toGeminiContents(request.messages),
      config: {
        systemInstruction: request.system,
        tools: hasTools
          ? [{
              functionDeclarations: request.tools!.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            }]
          : undefined,
        toolConfig: hasTools
          ? { functionCallingConfig: { mode: request.toolMode === "none" ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO } }
          : undefined,
        thinkingConfig: { thinkingLevel: LEVELS[this.opts.thinkingLevel ?? "low"] },
        abortSignal: signal,
        // We own retries/fallback (see stream()); one attempt per model.
        httpOptions: { retryOptions: { attempts: 1 } },
      },
    });

    const parts: Part[] = [];
    const toolCalls: ToolCall[] = [];
    let text = "";
    let usage: Usage = emptyUsage();

    for await (const chunk of response) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        parts.push(part);
        if (part.thought) continue;
        if (part.text) {
          text += part.text;
          yield { type: "text", delta: part.text };
        }
        if (part.functionCall) {
          const call: ToolCall = {
            id: part.functionCall.id ?? `${LOCAL_ID_PREFIX}${toolCalls.length}`,
            name: part.functionCall.name ?? "",
            args: part.functionCall.args ?? {},
          };
          toolCalls.push(call);
          yield { type: "tool_call", call };
        }
      }
      if (chunk.usageMetadata) usage = toUsage(chunk.usageMetadata);
    }

    yield {
      type: "done",
      model,
      usage,
      message: { role: "assistant", text, toolCalls, providerData: { geminiParts: compactParts(parts) } },
    };
  }
}

/** Map neutral messages to Gemini `contents`. Exported for unit tests. */
export function toGeminiContents(messages: ChatMessage[]): Content[] {
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      const raw = (m.providerData as { geminiParts?: Part[] } | undefined)?.geminiParts;
      const parts: Part[] = raw?.length
        ? raw
        : [
            ...(m.text ? [{ text: m.text }] : []),
            ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.args } })),
          ];
      if (parts.length) contents.push({ role: "model", parts });
    } else {
      contents.push({
        role: "user",
        parts: m.results.map((r) => ({
          functionResponse: {
            ...(r.callId.startsWith(LOCAL_ID_PREFIX) ? {} : { id: r.callId }),
            name: r.name,
            response: r.isError ? { error: r.content } : { output: r.content },
          },
        })),
      });
    }
  }
  return contents;
}

/** Merge adjacent plain text chunks; keep anything carrying a signature, thought or call exactly as received. */
export function compactParts(parts: Part[]): Part[] {
  const out: Part[] = [];
  for (const p of parts) {
    const plain = (x: Part) =>
      x.text !== undefined && !x.thought && !x.thoughtSignature && !x.functionCall && Object.keys(x).length === 1;
    const prev = out.at(-1);
    if (prev && plain(prev) && plain(p)) prev.text = (prev.text ?? "") + p.text;
    else out.push({ ...p });
  }
  return out;
}

function toUsage(u: GenerateContentResponseUsageMetadata): Usage {
  return {
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: u.candidatesTokenCount ?? 0,
    thinkingTokens: u.thoughtsTokenCount ?? 0,
    cachedTokens: u.cachedContentTokenCount ?? 0,
  };
}

export function toModelError(err: unknown, model: string): ModelError {
  if (err instanceof ModelError) return err;
  if (err instanceof ApiError) {
    const s = err.status;
    const msg = err.message ?? "";
    if (s === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg))
      return new ModelError("quota", `Gemini quota exceeded for ${model}. Rotate GEMINI_API_KEY or wait for the quota to reset.`, s, model);
    if (s === 503 || s === 500 || s === 502 || s === 504)
      return new ModelError("overloaded", `Gemini ${model} is overloaded (${s}).`, s, model);
    if (s === 401 || s === 403) return new ModelError("auth", `Gemini rejected the API key (${s}).`, s, model);
    if (s === 400 || s === 404) return new ModelError("bad_request", `Gemini rejected the request: ${msg.slice(0, 300)}`, s, model);
    return new ModelError("unknown", msg.slice(0, 300), s, model);
  }
  if (err instanceof Error && (err.name === "TimeoutError" || /timed? ?out/i.test(err.message)))
    return new ModelError("timeout", `Gemini ${model} timed out.`, undefined, model);
  if (err instanceof Error && err.name === "AbortError") return new ModelError("aborted", "Request cancelled.", undefined, model);
  return new ModelError("unknown", err instanceof Error ? err.message : String(err), undefined, model);
}
