import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn } from "../agent/loop.js";
import type { AgentEvent } from "../agent/types.js";
import { clock, isValidTimeZone } from "../lib/clock.js";
import { getConfig } from "../lib/config.js";
import { createChatModel } from "../llm/index.js";
import { createSearch } from "../search/index.js";

/** Transport only (ADR-011): parse the request, stream AgentEvents as SSE. No agent logic here. */

const config = getConfig();
const model = createChatModel(config);
const search = createSearch(config);

const ChatBody = z.object({
  message: z.string().trim().min(1).max(8_000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(40_000) }))
    .max(100)
    .default([]),
  tz: z.string().optional(),
});

const app = new Hono();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    provider: model.provider,
    model: model.model,
    search: search.name,
    now: clock.now().toISOString(),
    clockOverridden: clock.isOverridden(),
  }),
);

app.post("/api/chat", async (c) => {
  const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const { message, history, tz } = parsed.data;
  const timeZone = tz && isValidTimeZone(tz) ? tz : config.AGENT_TZ;

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    // Serialise writes: emit() is synchronous, SSE writes are async.
    let chain: Promise<unknown> = Promise.resolve();
    const emit = (event: AgentEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) }));
      if (event.type === "done") log(message, event);
      if (event.type === "error") console.error(`[turn] error ${event.kind}: ${event.message}`);
    };

    await runTurn({ history, userText: message, tz: timeZone, model, search, emit, signal: abort.signal });
    await chain;
  });
});

function log(message: string, event: Extract<AgentEvent, { type: "done" }>) {
  const m = event.metrics;
  console.log(
    `[turn] ${JSON.stringify(message.slice(0, 60))} model=${m.model} ttft=${m.ttftMs}ms total=${m.totalMs}ms ` +
      `steps=${m.steps} searches=${m.searchCalls} queries=${m.queries} sources=${event.sources.length} cited=${event.cited.length} ` +
      `tokens(in=${m.usage.inputTokens} out=${m.usage.outputTokens} think=${m.usage.thinkingTokens} cached=${m.usage.cachedTokens})` +
      (m.droppedCitations.length ? ` dropped=${m.droppedCitations.join(",")}` : ""),
  );
}

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`[server] http://localhost:${info.port}  model=${model.model}  search=${search.name}${clock.isOverridden() ? `  clock=${clock.now().toISOString()} (AGENT_NOW)` : ""}`);
});
