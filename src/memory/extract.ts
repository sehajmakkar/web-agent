import { z } from "zod";
import { EXTRACT_JSON_SCHEMA, EXTRACT_SYSTEM } from "../agent/prompts/extract.js";
import { generateJson } from "../llm/json.js";
import { ModelError, type ModelClient } from "../llm/types.js";
import type { Source } from "../tools/sources.js";
import type { Store } from "./store.js";

/**
 * Evidence extraction (ADR-007/013): after an answer is saved, a small model turns the exchange into
 * title + topics + claims (linked to the [n] source they were cited from) + user decisions.
 * Runs off the critical path; the user never waits for it.
 */

const Extraction = z.object({
  title: z.string().trim().max(120),
  topics: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(15),
  claims: z
    .array(
      z.object({
        entity: z.string().trim().min(1).max(80),
        attribute: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(200),
        source: z.number().int().nullable(),
      }),
    )
    .max(30),
  notes: z
    .array(
      z.object({
        kind: z.enum(["shortlist", "decision", "preference"]),
        subject: z.string().trim().min(1).max(80),
        items: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
        text: z.string().trim().max(300).optional(),
      }),
    )
    .max(10),
});
export type Extraction = z.infer<typeof Extraction>;

export interface ExtractJob {
  conversationId: string;
  assistantMessageId: string;
  question: string;
  answer: string;
  /** Sources the answer cited (with excerpts), as numbered in the answer. */
  cited: Source[];
}

export interface ExtractResult {
  claims: number;
  notes: number;
  titled: boolean;
  droppedSources: number;
  ms: number;
}

const EXCERPT_FOR_EXTRACTION = 500;

export function buildExtractPrompt(job: ExtractJob): string {
  const sources = job.cited.length
    ? job.cited.map((s) => `[${s.n}] ${s.title} (${s.url})${s.publishedAt ? `, published ${s.publishedAt.slice(0, 10)}` : ""}\n${s.excerpt.slice(0, EXCERPT_FOR_EXTRACTION)}`).join("\n\n")
    : "(no sources cited)";
  return `<user_message>\n${job.question}\n</user_message>\n\n<assistant_answer>\n${job.answer}\n</assistant_answer>\n\n<cited_sources>\n${sources}\n</cited_sources>`;
}

export async function extractEvidence(store: Store, model: ModelClient, job: ExtractJob, signal?: AbortSignal): Promise<ExtractResult> {
  const t0 = performance.now();
  const { value } = await generateJson(model, {
    system: EXTRACT_SYSTEM,
    prompt: buildExtractPrompt(job),
    jsonSchema: EXTRACT_JSON_SCHEMA as unknown as Record<string, unknown>,
    schema: Extraction,
    signal,
  });
  return { ...persistExtraction(store, job, value), ms: Math.round(performance.now() - t0) };
}

/** Validate against what is true (cited sources, conversation state), then write. Exported for tests. */
export function persistExtraction(store: Store, job: ExtractJob, x: Extraction): Omit<ExtractResult, "ms"> {
  const conv = store.getConversation(job.conversationId);
  if (!conv) throw new ModelError("bad_request", `Conversation ${job.conversationId} vanished before extraction`);
  const citedNs = new Set(job.cited.map((s) => s.n));
  const message = store.getMessages(job.conversationId).find((m) => m.id === job.assistantMessageId);
  if (!message) throw new ModelError("bad_request", `Message ${job.assistantMessageId} not found`);

  let claims = 0;
  let droppedSources = 0;
  let titled = false;
  store.db.transaction(() => {
    for (const c of x.claims) {
      // A claim may only point at a source this answer actually cited; otherwise keep the claim, unlinked.
      const sourceN = c.source !== null && citedNs.has(c.source) ? c.source : undefined;
      if (c.source !== null && sourceN === undefined) droppedSources++;
      store.addClaim({
        messageId: job.assistantMessageId, entity: c.entity, attribute: c.attribute, value: c.value,
        sourceN, observedAt: message.createdAt, supersede: true,
      });
      claims++;
    }
    for (const n of x.notes) {
      const payload = n.items?.length ? { subject: n.subject, items: n.items, context: n.text } : { subject: n.subject, text: n.text };
      store.addNote({ conversationId: job.conversationId, kind: n.kind, payload, at: new Date(message.createdAt) });
    }
    // Title only on the first exchange (later turns shouldn't rename a conversation); topics accumulate.
    const isFirstExchange = message.seq <= 2;
    if (isFirstExchange && x.title) titled = true;
    store.setTitle(conv.id, isFirstExchange && x.title ? x.title : conv.title, mergeTopics(conv.topics, x.topics));
  })();
  return { claims, notes: x.notes.length, titled, droppedSources };
}

function mergeTopics(existing: string[], extra: string[]): string[] {
  const out = [...existing];
  for (const t of extra) if (!out.includes(t)) out.push(t);
  return out.slice(0, 15);
}

/**
 * Fire-and-forget queue with an "idle" barrier (C6): the next turn's memory planning waits briefly for in-flight
 * extraction, so a follow-up that refers to the answer just given sees its claims.
 */
export class ExtractionQueue {
  private readonly inflight = new Set<Promise<void>>();
  constructor(
    private readonly run: (job: ExtractJob) => Promise<ExtractResult>,
    private readonly log: (line: string) => void = console.log,
  ) {}

  enqueue(job: ExtractJob): void {
    const p: Promise<void> = this.run(job)
      .then((r) =>
        this.log(`[extract] ${job.assistantMessageId.slice(0, 8)} claims=${r.claims} notes=${r.notes} titled=${r.titled}` +
          `${r.droppedSources ? ` unlinked=${r.droppedSources}` : ""} ${r.ms}ms`))
      .catch((err: unknown) => {
        const quota = err instanceof ModelError && err.kind === "quota";
        this.log(`[extract] ${quota ? "QUOTA" : "failed"} ${job.assistantMessageId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => this.inflight.delete(p));
    this.inflight.add(p);
  }

  get size(): number {
    return this.inflight.size;
  }

  /** Resolves when all in-flight jobs finish, or after timeoutMs (returns false on timeout). */
  async idle(timeoutMs: number): Promise<boolean> {
    if (!this.inflight.size) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = Promise.allSettled([...this.inflight]).then(() => true as const);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return result;
  }
}
