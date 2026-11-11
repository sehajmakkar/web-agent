import { clock } from "../lib/clock.js";
import { ModelError, addUsage, emptyUsage, type ChatMessage, type ModelClient, type ToolCall, type ToolResult } from "../llm/types.js";
import type { SearchProvider } from "../search/types.js";
import { SourceRegistry, validateCitations } from "../tools/sources.js";
import { WEB_SEARCH, runWebSearch, webSearchSpec } from "../tools/webSearch.js";
import { buildRequest, buildTurnContext, type HistoryMessage } from "./context.js";
import type { AgentEvent, TurnMetrics } from "./types.js";

export interface TurnInput {
  history: HistoryMessage[];
  userText: string;
  tz: string;
  model: ModelClient;
  search: SearchProvider;
  emit: (event: AgentEvent) => void;
  signal?: AbortSignal;
  /** Loop guards. */
  maxSteps?: number;
  budgetMs?: number;
}

/**
 * One user turn: stream → run tool calls in parallel → feed results back → repeat → final answer.
 * No HTTP/UI knowledge here, so the server, CLI and eval runner all share it.
 */
export async function runTurn(input: TurnInput): Promise<void> {
  const { model, search, emit, signal } = input;
  const maxSteps = input.maxSteps ?? 4;
  const budgetMs = input.budgetMs ?? 45_000;
  const t0 = clock.perf();
  const elapsed = () => Math.round(clock.perf() - t0);

  const registry = new SourceRegistry();
  const turnContext = buildTurnContext({ now: clock.now(), tz: input.tz });
  const { system, messages } = buildRequest({ history: input.history, userText: input.userText, turnContext });
  const conversation: ChatMessage[] = [...messages];

  let answer = "";
  let ttftMs: number | null = null;
  let usage = emptyUsage();
  let modelUsed = model.model;
  let steps = 0;
  let searchCalls = 0;
  let queries = 0;
  let forceAnswer = false;

  try {
    for (let step = 0; step < maxSteps; step++) {
      steps++;
      // Final step (or out of time, or an empty reply last time): force a text answer with what we have.
      const mustAnswer = forceAnswer || step === maxSteps - 1 || elapsed() > budgetMs;
      const calls: ToolCall[] = [];

      for await (const ev of model.stream({ system, messages: conversation, tools: [webSearchSpec], toolMode: mustAnswer ? "none" : "auto", signal })) {
        if (ev.type === "text") {
          if (ttftMs === null) ttftMs = elapsed();
          answer += ev.delta;
          emit({ type: "text", delta: ev.delta });
        } else if (ev.type === "tool_call") {
          calls.push(ev.call);
        } else {
          conversation.push(ev.message);
          usage = addUsage(usage, ev.usage);
          modelUsed = ev.model;
        }
      }

      if (!calls.length) {
        if (answer.trim() || mustAnswer) break;
        // Model returned nothing: one forced-answer retry on the next step.
        forceAnswer = true;
        continue;
      }

      // Separate pre-tool chatter ("Let me check…") from the final answer.
      if (answer && !answer.endsWith("\n")) {
        answer += "\n\n";
        emit({ type: "text", delta: "\n\n" });
      }

      const results: ToolResult[] = await Promise.all(
        calls.map(async (call): Promise<ToolResult> => {
          if (call.name !== WEB_SEARCH) {
            return { callId: call.id, name: call.name, isError: true, content: `Unknown tool "${call.name}". The only tool is ${WEB_SEARCH}.` };
          }
          searchCalls++;
          queries += Array.isArray(call.args.queries) ? call.args.queries.length : 0;
          return runWebSearch(call.id, call.args, {
            search,
            registry,
            signal,
            onStatus: (text) => emit({ type: "status", text }),
            onSources: (sources) => emit({ type: "sources", sources }),
          });
        }),
      );
      conversation.push({ role: "tool", results });
      emit({ type: "status", text: "Reading results…" });
    }

    const { text, cited, dropped } = validateCitations(answer.trim(), (n) => registry.has(n));
    const metrics: TurnMetrics = {
      model: modelUsed,
      ttftMs,
      totalMs: elapsed(),
      steps,
      searchCalls,
      queries,
      usage,
      droppedCitations: dropped,
    };
    emit({ type: "done", text, sources: registry.list(), cited, metrics });
  } catch (err) {
    if (err instanceof ModelError) emit({ type: "error", kind: err.kind, message: err.message });
    else emit({ type: "error", kind: "internal", message: err instanceof Error ? err.message : String(err) });
  }
}
