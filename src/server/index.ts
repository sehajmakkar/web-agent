import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runTurn } from "../agent/loop.js";
import type { AgentEvent } from "../agent/types.js";
import { openDb } from "../db/client.js";
import { clock, isValidTimeZone } from "../lib/clock.js";
import { getConfig } from "../lib/config.js";
import { createChatModel } from "../llm/index.js";
import { Store } from "../memory/store.js";
import { createSearch } from "../search/index.js";
import type { Source } from "../tools/sources.js";

/** Transport + persistence wiring only (ADR-011). Agent logic lives in src/agent. */

const config = getConfig();
const model = createChatModel(config);
const search = createSearch(config);
const store = new Store(openDb(config.DB_PATH));

const ChatBody = z.object({
  conversationId: z.string().uuid().or(z.string().regex(/^conv-[\w-]+$/)).optional(),
  message: z.string().trim().min(1).max(8_000),
  tz: z.string().optional(),
});

const app = new Hono();

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    provider: model.provider,
    model: model.model,
    search: search.name,
    db: config.DB_PATH,
    now: clock.now().toISOString(),
    clockOverridden: clock.isOverridden(),
  }),
);

app.get("/api/conversations", (c) => c.json({ conversations: store.listConversations() }));

app.get("/api/conversations/:id", (c) => {
  const conversation = store.getConversation(c.req.param("id"));
  if (!conversation) return c.json({ error: "Not found" }, 404);
  return c.json({ conversation, messages: store.getMessages(conversation.id) });
});

app.delete("/api/conversations/:id", (c) =>
  store.deleteConversation(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "Not found" }, 404),
);

app.post("/api/chat", async (c) => {
  const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
  const { conversationId, message } = parsed.data;
  const tz = parsed.data.tz && isValidTimeZone(parsed.data.tz) ? parsed.data.tz : config.AGENT_TZ;

  const conversation = conversationId ? store.getConversation(conversationId) : store.createConversation({ tz });
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  // History = what was said before this message (ADR-020: plain text turns).
  const history = store.getMessages(conversation.id).map((m) => ({ role: m.role, content: m.content }));
  // Persist the question first: "what did I ask on X" must include questions whose answer failed.
  store.appendMessage({ conversationId: conversation.id, role: "user", content: message });

  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    let chain: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown) => {
      chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
    };

    send("conversation", { type: "conversation", conversation: store.getConversation(conversation.id) });

    const emit = (event: AgentEvent) => {
      if (event.type === "done") {
        const cited = new Set(event.cited);
        const saved = store.appendMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: event.text,
          meta: { metrics: event.metrics },
          sources: event.sources.map((source) => ({ source, cited: cited.has(source.n) })),
        });
        log(message, event);
        send("done", { ...event, sources: event.sources.map(forWire), messageId: saved.id });
        send("conversation", { type: "conversation", conversation: store.getConversation(conversation.id) });
        return;
      }
      if (event.type === "error") console.error(`[turn] error ${event.kind}: ${event.message}`);
      send(event.type, event.type === "sources" ? { ...event, sources: event.sources.map(forWire) } : event);
    };

    await runTurn({ history, userText: message, tz, model, search, emit, signal: abort.signal });
    await chain;
  });
});

/** Excerpts stay server-side (they can be several KB each); the UI needs only the link metadata. */
function forWire({ excerpt: _excerpt, ...rest }: Source) {
  return rest;
}

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
  console.log(
    `[server] http://localhost:${info.port}  model=${model.model}  search=${search.name}  db=${config.DB_PATH}` +
      (clock.isOverridden() ? `  clock=${clock.now().toISOString()} (AGENT_NOW)` : ""),
  );
});
