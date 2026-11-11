import { clock } from "../lib/clock.js";
import { ModelError, addUsage, emptyUsage, type ChatMessage, type ModelClient, type ToolCall, type ToolResult } from "../llm/types.js";
import { planMemory } from "../memory/retrieve.js";
import type { Store } from "../memory/store.js";
import { formatDay } from "../memory/temporal.js";
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
  /** Long-term memory. Without it the agent states it has no earlier conversations. */
  memory?: { store: Store; currentConversationId?: string };
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
  const now = clock.now();
  // Memory is planned in code before the model runs (ADR-005 A): dates, recall, the search window.
  const plan = planMemory(input.memory?.store, {
    text: input.userText,
    now,
    tz: input.tz,
    excludeConversationId: input.memory?.currentConversationId,
  });
  if (plan.trace.recalled.length) {
    const first = plan.trace.recalled[0]!;
    const more = plan.trace.recalled.length > 1 ? ` +${plan.trace.recalled.length - 1} more` : "";
    emit({ type: "status", text: `Recalled ${formatDay(first.localDate)}: “${first.title}”${more}` });
  }
  const searches: TurnMetrics["searches"] = [];

  // ADR-027: the code knows which pages to re-check, so it reads them before the model runs (no model round trip,
  // and the primary page is guaranteed to be read). Phase 4 caught the model inventing `site:` queries for this instead.
  let prefetched: string | undefined;
  if (plan.verifyUrls.length) {
    searches.push({ queries: [], urls: plan.verifyUrls, since: plan.since, prefetch: true });
    const r = await runWebSearch("prefetch", { urls: plan.verifyUrls }, {
      search, registry, signal,
      onStatus: () => emit({ type: "status", text: `Re-reading ${plan.verifyUrls.length} page(s) cited back then…` }),
      onSources: (sources) => emit({ type: "sources", sources }),
    });
    if (!r.isError) prefetched = r.content;
  }
  const turnContext = buildTurnContext({ now, tz: input.tz, extra: plan.contextLines, memory: plan.memoryBlock, prefetched });
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
      let stepText = "";

      for await (const ev of model.stream({ system, messages: conversation, tools: [webSearchSpec], toolMode: mustAnswer ? "none" : "auto", signal })) {
        if (ev.type === "text") {
          if (ttftMs === null) ttftMs = elapsed();
          stepText += ev.delta;
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
        answer = stepText;
        if (answer.trim() || mustAnswer) break;
        // Model returned nothing: one forced-answer retry on the next step.
        forceAnswer = true;
        continue;
      }

      // ADR-024: text written before a tool call is a draft made without evidence (Phase 3 caught the model writing
      // an unverified table, then searching). Only the final step's text is the answer; tell the UI to drop the draft.
      if (stepText) {
        emit({ type: "reset" });
        ttftMs = null;
      }

      const results: ToolResult[] = await Promise.all(
        calls.map(async (call): Promise<ToolResult> => {
          if (call.name !== WEB_SEARCH) {
            return { callId: call.id, name: call.name, isError: true, content: `Unknown tool "${call.name}". The only tool is ${WEB_SEARCH}.` };
          }
          searchCalls++;
          const qs = Array.isArray(call.args.queries) ? call.args.queries.map(String) : [];
          const us = Array.isArray(call.args.urls) ? call.args.urls.map(String) : [];
          queries += qs.length;
          searches.push({ queries: qs, urls: us, since: plan.since ?? (typeof call.args.since === "string" ? call.args.since : undefined) });
          return runWebSearch(call.id, call.args, {
            search,
            registry,
            forcedSince: plan.since,
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
      memory: {
        dates: plan.trace.dates,
        recalled: plan.trace.recalled,
        since: plan.trace.since,
        sinceReason: plan.trace.sinceReason,
        memoryIntent: plan.trace.memoryIntent,
        changeIntent: plan.trace.changeIntent,
      },
      searches,
    };
    emit({ type: "done", text, sources: registry.list(), cited, metrics });
  } catch (err) {
    if (err instanceof ModelError) emit({ type: "error", kind: err.kind, message: err.message });
    else emit({ type: "error", kind: "internal", message: err instanceof Error ? err.message : String(err) });
  }
}
