import fs from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Store } from "./store.js";

/**
 * Load backdated history from evals/fixtures/history.yaml into a Store.
 * Shared by `npm run seed:demo` and (Phase 5) the eval runner, so demos and evals see identical memory.
 */

const FixtureSource = z.object({ n: z.number().int(), url: z.string(), title: z.string().default("") });
const FixtureMessage = z.object({
  role: z.enum(["user", "assistant"]),
  at: z.coerce.date(),
  content: z.string(),
  sources: z.array(FixtureSource).default([]),
  claims: z
    .array(z.object({ entity: z.string(), attribute: z.string(), value: z.string(), source: z.number().int().optional(), quote: z.string().optional() }))
    .default([]),
});
const FixtureConversation = z.object({
  id: z.string(),
  started_at: z.coerce.date(),
  tz: z.string(),
  title: z.string().default(""),
  topics: z.array(z.string()).default([]),
  messages: z.array(FixtureMessage),
  notes: z.array(z.object({ kind: z.string(), payload: z.unknown() })).default([]),
});
const SeedSet = z.union([
  z.array(FixtureConversation),
  z.object({ extends: z.string(), add: z.array(FixtureConversation) }),
]);
const FixtureFile = z.object({ seeds: z.record(z.string(), SeedSet) });

export type FixtureConversation = z.infer<typeof FixtureConversation>;

export function loadSeedSet(file: string, name: string): FixtureConversation[] {
  const doc = FixtureFile.parse(parse(fs.readFileSync(file, "utf8")));
  const resolve = (n: string, depth = 0): FixtureConversation[] => {
    const set = doc.seeds[n];
    if (!set) throw new Error(`Unknown seed set "${n}" (have: ${Object.keys(doc.seeds).join(", ")})`);
    if (depth > 5) throw new Error("Seed `extends` chain too deep");
    return Array.isArray(set) ? set : [...resolve(set.extends, depth + 1), ...set.add];
  };
  return resolve(name);
}

export function seed(store: Store, conversations: FixtureConversation[]): { conversations: number; messages: number } {
  let messages = 0;
  store.db.transaction(() => {
    for (const c of conversations) {
      store.createConversation({ id: c.id, tz: c.tz, at: c.started_at, title: c.title, topics: c.topics });
      for (const m of c.messages) {
        const saved = store.appendMessage({
          conversationId: c.id,
          role: m.role,
          content: m.content.trim(),
          at: m.at,
          sources: m.sources.map((s) => ({
            source: { n: s.n, url: s.url, title: s.title, provider: "fixture", excerpt: `(fixture snapshot) ${s.title}` },
            cited: true,
          })),
        });
        for (const cl of m.claims)
          store.addClaim({ messageId: saved.id, entity: cl.entity, attribute: cl.attribute, value: cl.value, sourceN: cl.source, quote: cl.quote, observedAt: m.at.toISOString() });
        messages++;
      }
      for (const n of c.notes) store.addNote({ conversationId: c.id, kind: n.kind, payload: n.payload, at: c.messages.at(-1)?.at ?? c.started_at });
    }
  })();
  return { conversations: conversations.length, messages };
}
