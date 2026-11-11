// Client side of the SSE contract. Types mirror src/agent/types.ts (kept local so the UI bundle has no server imports).

export interface Source {
  n: number;
  url: string;
  title: string;
  publishedAt?: string;
  provider: string;
}

export interface Metrics {
  model: string;
  ttftMs: number | null;
  totalMs: number;
  steps: number;
  searchCalls: number;
  queries: number;
}

export interface Conversation {
  id: string;
  title: string;
  tz: string;
  startedAt: string;
  localDate: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  meta?: { metrics?: Metrics };
  sources: (Source & { cited: boolean })[];
}

export type AgentEvent =
  | { type: "conversation"; conversation: Conversation }
  | { type: "status"; text: string }
  | { type: "text"; delta: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; text: string; sources: Source[]; cited: number[]; metrics: Metrics; messageId: string }
  | { type: "error"; kind: string; message: string };

export interface Health {
  model: string;
  search: string;
  db: string;
  now: string;
  clockOverridden: boolean;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const getHealth = () => getJson<Health>("/api/health");
export const listConversations = () => getJson<{ conversations: Conversation[] }>("/api/conversations").then((r) => r.conversations);
export const getConversation = (id: string) =>
  getJson<{ conversation: Conversation; messages: StoredMessage[] }>(`/api/conversations/${encodeURIComponent(id)}`);
export const deleteConversation = (id: string) =>
  getJson<{ ok: boolean }>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });

/** POST a turn and invoke onEvent for each SSE event. Resolves when the stream ends. */
export async function streamChat(
  body: { conversationId?: string; message: string; tz: string },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}
