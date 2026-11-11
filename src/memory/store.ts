import { createHash, randomUUID } from "node:crypto";
import type { DB } from "../db/client.js";
import { clock, localDate } from "../lib/clock.js";
import type { Source } from "../tools/sources.js";

/** All SQL for conversations/messages/evidence lives here (CLAUDE.md conventions). */

export interface Conversation {
  id: string;
  title: string;
  topics: string[];
  tz: string;
  startedAt: string;
  localDate: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredSource extends Omit<Source, "excerpt"> {
  cited: boolean;
  fetchedAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  localDate: string;
  meta?: Record<string, unknown>;
  sources: StoredSource[];
}

export interface NewMessage {
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  /** Defaults to clock.now(); seeds pass explicit timestamps. */
  at?: Date;
  meta?: Record<string, unknown>;
  sources?: { source: Source; cited: boolean }[];
}

type ConvRow = {
  id: string; title: string; topics: string; tz: string; started_at: string; local_date: string; updated_at: string; message_count: number;
};
type MsgRow = {
  id: string; conversation_id: string; seq: number; role: "user" | "assistant"; content: string; created_at: string; local_date: string; meta: string | null;
};
type SrcRow = {
  message_id: string; n: number; cited: number; url: string; title: string; provider: string; published_at: string | null; fetched_at: string;
};

const TITLE_MAX = 80;

export class Store {
  constructor(readonly db: DB) {}

  createConversation(input: { tz: string; at?: Date; id?: string; title?: string; topics?: string[] }): Conversation {
    const at = input.at ?? clock.now();
    const iso = at.toISOString();
    const id = input.id ?? randomUUID();
    this.db
      .prepare(`INSERT INTO conversations (id, title, topics, tz, started_at, local_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.title ?? "", JSON.stringify(input.topics ?? []), input.tz, iso, localDate(at, input.tz), iso);
    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.db
      .prepare(`SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count FROM conversations c WHERE c.id = ?`)
      .get(id) as ConvRow | undefined;
    return row && toConversation(row);
  }

  /** Most recently active first. */
  listConversations(limit = 100): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(limit) as ConvRow[];
    return rows.map(toConversation);
  }

  deleteConversation(id: string): boolean {
    return this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id).changes > 0;
  }

  setTitle(id: string, title: string, topics?: string[]) {
    this.db
      .prepare(`UPDATE conversations SET title = ?, topics = COALESCE(?, topics) WHERE id = ?`)
      .run(title.slice(0, TITLE_MAX), topics ? JSON.stringify(topics) : null, id);
  }

  /** Append a message (and its source snapshots) atomically. */
  appendMessage(input: NewMessage): StoredMessage {
    const conv = this.getConversation(input.conversationId);
    if (!conv) throw new Error(`Unknown conversation ${input.conversationId}`);
    const at = input.at ?? clock.now();
    const iso = at.toISOString();
    const id = randomUUID();

    this.db.transaction(() => {
      const { next } = this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?`)
        .get(input.conversationId) as { next: number };
      this.db
        .prepare(`INSERT INTO messages (id, conversation_id, seq, role, content, created_at, local_date, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.conversationId, next, input.role, input.content, iso, localDate(at, conv.tz), input.meta ? JSON.stringify(input.meta) : null);

      const insSource = this.db.prepare(
        `INSERT INTO sources (url, title, provider, published_at, fetched_at, excerpt, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      const link = this.db.prepare(`INSERT INTO message_sources (message_id, source_id, n, cited) VALUES (?, ?, ?, ?)`);
      for (const { source, cited } of input.sources ?? []) {
        const { lastInsertRowid } = insSource.run(
          source.url, source.title, source.provider, source.publishedAt ?? null, iso, source.excerpt, hash(source.excerpt),
        );
        link.run(id, lastInsertRowid, source.n, cited ? 1 : 0);
      }

      // First user message names the conversation until extraction (Phase 4) writes a better title.
      if (input.role === "user" && !conv.title) this.setTitle(conv.id, oneLine(input.content));
      this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ? AND updated_at < ?`).run(iso, conv.id, iso);
    })();

    return this.getMessages(input.conversationId).find((m) => m.id === id)!;
  }

  getMessages(conversationId: string): StoredMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq`)
      .all(conversationId) as MsgRow[];
    const srcRows = this.db
      .prepare(
        `SELECT ms.message_id, ms.n, ms.cited, s.url, s.title, s.provider, s.published_at, s.fetched_at
         FROM message_sources ms JOIN sources s ON s.id = ms.source_id
         JOIN messages m ON m.id = ms.message_id
         WHERE m.conversation_id = ? ORDER BY ms.n`,
      )
      .all(conversationId) as SrcRow[];
    const byMessage = new Map<string, StoredSource[]>();
    for (const s of srcRows) {
      const list = byMessage.get(s.message_id) ?? [];
      list.push({
        n: s.n, url: s.url, title: s.title, provider: s.provider, publishedAt: s.published_at ?? undefined,
        cited: s.cited === 1, fetchedAt: s.fetched_at,
      });
      byMessage.set(s.message_id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      localDate: r.local_date,
      meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : undefined,
      sources: byMessage.get(r.id) ?? [],
    }));
  }

  /** Evidence ledger writes (seeds now, extraction in Phase 4). */
  addClaim(input: { messageId: string; entity: string; attribute: string; value: string; sourceN?: number; quote?: string; observedAt: string }) {
    const sourceId = input.sourceN === undefined ? null : (this.db
      .prepare(`SELECT source_id FROM message_sources WHERE message_id = ? AND n = ?`)
      .get(input.messageId, input.sourceN) as { source_id: number } | undefined)?.source_id ?? null;
    this.db
      .prepare(`INSERT INTO claims (message_id, entity, attribute, value, source_id, quote, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(input.messageId, input.entity, input.attribute, input.value, sourceId, input.quote ?? null, input.observedAt);
  }

  addNote(input: { conversationId: string; kind: string; payload: unknown; at?: Date }) {
    this.db
      .prepare(`INSERT INTO notes (conversation_id, kind, payload, created_at) VALUES (?, ?, ?, ?)`)
      .run(input.conversationId, input.kind, JSON.stringify(input.payload), (input.at ?? clock.now()).toISOString());
  }
}

function toConversation(r: ConvRow): Conversation {
  return {
    id: r.id,
    title: r.title,
    topics: JSON.parse(r.topics) as string[],
    tz: r.tz,
    startedAt: r.started_at,
    localDate: r.local_date,
    updatedAt: r.updated_at,
    messageCount: r.message_count,
  };
}

function oneLine(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
