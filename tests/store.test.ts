import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/agent/context.js";
import { openDb } from "../src/db/client.js";
import { loadSeedSet, seed } from "../src/memory/seed.js";
import { Store } from "../src/memory/store.js";

const newStore = () => new Store(openDb(":memory:"));
const src = (n: number, url: string) => ({ n, url, title: `T${n}`, provider: "test", excerpt: `excerpt ${n}` });

describe("Store", () => {
  it("appends messages in order, titles from the first user message, keeps source snapshots", () => {
    const store = newStore();
    const conv = store.createConversation({ tz: "Europe/London", at: new Date("2026-11-03T14:20:00Z") });
    store.appendMessage({ conversationId: conv.id, role: "user", content: "Cheapest  managed\nPostgres?", at: new Date("2026-11-03T14:20:00Z") });
    store.appendMessage({
      conversationId: conv.id, role: "assistant", content: "Render [1], Neon [2]", at: new Date("2026-11-03T14:20:20Z"),
      sources: [{ source: src(1, "https://render.com/pricing"), cited: true }, { source: src(2, "https://neon.com/pricing"), cited: false }],
    });
    const msgs = store.getMessages(conv.id);
    expect(msgs.map((m) => [m.seq, m.role])).toEqual([[1, "user"], [2, "assistant"]]);
    expect(msgs[1]!.sources.map((s) => [s.n, s.cited])).toEqual([[1, true], [2, false]]);
    expect(store.getConversation(conv.id)!.title).toBe("Cheapest managed Postgres?");
    expect(store.getConversation(conv.id)!.updatedAt).toBe("2026-11-03T14:20:20.000Z");
  });

  it("stores local_date in the conversation's timezone (C5)", () => {
    const store = newStore();
    const at = new Date("2026-11-03T23:30:00Z");
    const tokyo = store.createConversation({ tz: "Asia/Tokyo", at });
    const la = store.createConversation({ tz: "America/Los_Angeles", at });
    expect(tokyo.localDate).toBe("2026-11-04");
    expect(la.localDate).toBe("2026-11-03");
    const m = store.appendMessage({ conversationId: tokyo.id, role: "user", content: "hi", at });
    expect(m.localDate).toBe("2026-11-04");
  });

  it("keeps the FTS index in sync and cascades deletes", () => {
    const store = newStore();
    const conv = store.createConversation({ tz: "UTC" });
    store.appendMessage({ conversationId: conv.id, role: "user", content: "Which Postgres hosting is cheapest?" });
    const hits = () => (store.db.prepare(`SELECT count(*) AS c FROM messages_fts WHERE messages_fts MATCH 'hosting'`).get() as { c: number }).c;
    expect(hits()).toBe(1);
    expect(store.deleteConversation(conv.id)).toBe(true);
    expect(hits()).toBe(0);
    expect(store.listConversations()).toHaveLength(0);
  });
});

describe("seed fixtures", () => {
  it("loads the base set with claims, notes and backdated local dates", () => {
    const store = newStore();
    const r = seed(store, loadSeedSet("evals/fixtures/history.yaml", "base"));
    expect(r.conversations).toBe(4);
    const dates = store.listConversations().map((c) => c.localDate).sort();
    expect(dates).toEqual(["2026-11-03", "2026-11-03", "2026-11-09", "2026-11-10"]);
    const claims = store.db.prepare(`SELECT entity, value, source_id IS NOT NULL AS linked FROM claims ORDER BY entity`).all();
    expect(claims).toEqual([
      { entity: "Neon", value: "$19/mo", linked: 1 },
      { entity: "Render", value: "$6/mo", linked: 1 },
      { entity: "Supabase", value: "$25/mo per project", linked: 1 },
    ]);
    const note = store.db.prepare(`SELECT payload FROM notes WHERE kind = 'shortlist'`).get() as { payload: string };
    expect(JSON.parse(note.payload).items).toEqual(["HubSpot", "Pipedrive", "Close", "Attio", "Zoho CRM"]);
  });

  it("resolves `extends` (ambiguous_tuesday = base + 1)", () => {
    expect(loadSeedSet("evals/fixtures/history.yaml", "ambiguous_tuesday")).toHaveLength(5);
  });
});

describe("buildRequest", () => {
  it("merges consecutive same-role turns and attaches turn context only to the current message", () => {
    const { messages } = buildRequest({
      history: [{ role: "user", content: "q1 (answer failed)" }],
      userText: "q1 again",
      turnContext: "<turn_context/>",
    });
    expect(messages).toEqual([{ role: "user", text: "q1 (answer failed)\n\nq1 again\n\n<turn_context/>" }]);
  });
});
