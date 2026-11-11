import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client.js";
import { generateJson } from "../src/llm/json.js";
import type { ModelClient, ModelEvent, ModelRequest } from "../src/llm/types.js";
import { ExtractionQueue, buildExtractPrompt, extractEvidence, persistExtraction, type ExtractJob } from "../src/memory/extract.js";
import { Store } from "../src/memory/store.js";
import { z } from "zod";

/** Fake model that streams a fixed JSON reply and records the request. */
class FakeModel implements ModelClient {
  readonly provider = "fake";
  readonly model = "fake-1";
  last?: ModelRequest;
  constructor(private readonly reply: string) {}
  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    this.last = req;
    yield { type: "text", delta: this.reply.slice(0, 10) };
    yield { type: "text", delta: this.reply.slice(10) };
    yield { type: "done", model: this.model, usage: { inputTokens: 1, outputTokens: 1, thinkingTokens: 0, cachedTokens: 0 }, message: { role: "assistant", text: this.reply } };
  }
}

function setup(at = "2026-11-03T14:20:00Z") {
  const store = new Store(openDb(":memory:"));
  const conv = store.createConversation({ tz: "Europe/London", at: new Date(at) });
  store.appendMessage({ conversationId: conv.id, role: "user", content: "Cheapest managed Postgres? Neon vs Supabase", at: new Date(at) });
  const src = (n: number, url: string) => ({ n, url, title: url, provider: "exa", excerpt: `excerpt for ${url}` });
  const sources = [src(1, "https://neon.com/pricing"), src(2, "https://supabase.com/pricing"), src(3, "https://blog.example.com/x")];
  const answer = store.appendMessage({
    conversationId: conv.id, role: "assistant", content: "Neon Launch is $19/mo [1]. Supabase Pro is $25/mo [2].",
    at: new Date(new Date(at).getTime() + 20_000),
    sources: sources.map((s) => ({ source: s, cited: s.n !== 3 })),
  });
  const job: ExtractJob = { conversationId: conv.id, assistantMessageId: answer.id, question: "Cheapest managed Postgres?", answer: answer.content, cited: sources.slice(0, 2) };
  return { store, conv, job };
}

const reply = (over: object = {}) =>
  JSON.stringify({
    title: "Managed Postgres hosting comparison",
    topics: ["postgres", "database hosting", "neon", "supabase"],
    claims: [
      { entity: "Neon", attribute: "Launch plan price", value: "$19/mo", source: 1 },
      { entity: "Supabase", attribute: "Pro plan price", value: "$25/mo", source: 2 },
      { entity: "Render", attribute: "Basic price", value: "$6/mo", source: 3 }, // [3] wasn't cited → must not link
    ],
    notes: [{ kind: "preference", subject: "budget", text: "under $30/mo" }],
    ...over,
  });

describe("extractEvidence", () => {
  it("persists claims linked to the cited source, notes, title and topics", async () => {
    const { store, conv, job } = setup();
    const model = new FakeModel(reply());
    const r = await extractEvidence(store, model, job);
    expect(r).toMatchObject({ claims: 3, notes: 1, titled: true, droppedSources: 1 });
    expect(model.last?.jsonSchema).toBeDefined();
    const ev = store.evidence(conv.id);
    expect(ev.claims.map((c) => [c.entity, c.value, c.url ?? null])).toEqual([
      ["Neon", "$19/mo", "https://neon.com/pricing"],
      ["Supabase", "$25/mo", "https://supabase.com/pricing"],
      ["Render", "$6/mo", null], // kept, but unlinked
    ]);
    expect(ev.claims[0]!.observedAt).toBe("2026-11-03T14:20:20.000Z");
    expect(ev.notes[0]).toMatchObject({ kind: "preference", payload: { subject: "budget", text: "under $30/mo" } });
    const updated = store.getConversation(conv.id)!;
    expect(updated.title).toBe("Managed Postgres hosting comparison");
    expect(updated.topics).toEqual(["postgres", "database hosting", "neon", "supabase"]);
  });

  it("links a later claim on the same fact to the one it supersedes (history, not overwrite)", async () => {
    const { store, job } = setup();
    await extractEvidence(store, new FakeModel(reply()), job);
    // A week later, in a new conversation, Neon's price is observed again.
    const conv2 = store.createConversation({ tz: "Europe/London", at: new Date("2026-11-11T10:00:00Z") });
    store.appendMessage({ conversationId: conv2.id, role: "user", content: "Has Neon changed?", at: new Date("2026-11-11T10:00:00Z") });
    const a2 = store.appendMessage({
      conversationId: conv2.id, role: "assistant", content: "Neon Launch is now usage-based [1].", at: new Date("2026-11-11T10:00:10Z"),
      sources: [{ source: { n: 1, url: "https://neon.com/pricing", title: "Neon", provider: "exa", excerpt: "usage-based" }, cited: true }],
    });
    persistExtraction(store, { conversationId: conv2.id, assistantMessageId: a2.id, question: "q", answer: a2.content, cited: [] },
      { title: "Neon pricing re-check", topics: ["neon"], claims: [{ entity: "neon", attribute: "launch plan price", value: "usage-based", source: null }], notes: [] });
    const history = store.claimHistory("Neon", "Launch plan price");
    expect(history.map((h) => h.value)).toEqual(["$19/mo", "usage-based"]);
    expect(history[1]!.supersedes).toBeDefined();
  });

  it("does not rename a conversation after its first exchange, but keeps adding topics", () => {
    const { store, conv, job } = setup();
    store.setTitle(conv.id, "Original title", ["postgres"]);
    store.appendMessage({ conversationId: conv.id, role: "user", content: "and Render?" });
    const a = store.appendMessage({ conversationId: conv.id, role: "assistant", content: "Render is $6 [1]." });
    const r = persistExtraction(store, { ...job, assistantMessageId: a.id }, { title: "Render pricing", topics: ["render", "postgres"], claims: [], notes: [] });
    expect(r.titled).toBe(false);
    expect(store.getConversation(conv.id)).toMatchObject({ title: "Original title", topics: ["postgres", "render"] });
  });

  it("rejects malformed model output instead of writing garbage", async () => {
    const { store, conv, job } = setup();
    await expect(extractEvidence(store, new FakeModel("{not json"), job)).rejects.toThrow(/invalid JSON/);
    await expect(extractEvidence(store, new FakeModel(JSON.stringify({ title: 1 })), job)).rejects.toThrow(/validation/);
    expect(store.evidence(conv.id).claims).toEqual([]);
  });

  it("prompt includes the question, answer and cited excerpts only", () => {
    const { job } = setup();
    const p = buildExtractPrompt(job);
    expect(p).toContain("<assistant_answer>\nNeon Launch is $19/mo [1].");
    expect(p).toContain("[2] https://supabase.com/pricing");
    expect(p).not.toContain("blog.example.com");
  });
});

describe("ExtractionQueue", () => {
  it("idle() waits for in-flight jobs, and times out without throwing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const logs: string[] = [];
    const q = new ExtractionQueue(async () => {
      await gate;
      return { claims: 1, notes: 0, titled: false, droppedSources: 0, ms: 1 };
    }, (l) => logs.push(l));
    q.enqueue({ conversationId: "c", assistantMessageId: "m1234567", question: "", answer: "", cited: [] });
    expect(q.size).toBe(1);
    expect(await q.idle(20)).toBe(false);
    release();
    expect(await q.idle(1_000)).toBe(true);
    expect(q.size).toBe(0);
    expect(logs[0]).toContain("claims=1");
  });

  it("logs failures (quota included) instead of crashing the server", async () => {
    const logs: string[] = [];
    const q = new ExtractionQueue(async () => {
      throw new Error("boom");
    }, (l) => logs.push(l));
    q.enqueue({ conversationId: "c", assistantMessageId: "m1234567", question: "", answer: "", cited: [] });
    await q.idle(1_000);
    expect(logs[0]).toContain("failed");
  });
});

describe("generateJson", () => {
  it("validates with zod after parsing", async () => {
    const r = await generateJson(new FakeModel('{"a":1}'), { system: "", prompt: "", jsonSchema: {}, schema: z.object({ a: z.number() }) });
    expect(r.value).toEqual({ a: 1 });
  });
});
