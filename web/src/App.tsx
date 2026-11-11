import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { getHealth, streamChat, type AgentEvent, type Health, type Metrics, type Source } from "./api";
import { Markdown } from "./Markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  cited?: number[];
  status?: string;
  error?: string;
  metrics?: Metrics;
  streaming?: boolean;
}

const SUGGESTIONS = [
  "Has HubSpot, Pipedrive or Attio changed pricing since 1 November?",
  "What's the latest Node.js release and what's new in it?",
  "Compare Neon, Supabase and Render for managed Postgres pricing",
  "What did I ask you on 3 November?",
];

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const uid = () => Math.random().toString(36).slice(2);

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = messages.some((m) => m.streaming);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const patch = (id: string, fn: (m: Message) => Message) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    const history = messages
      .filter((m) => !m.error && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));
    const assistantId = uid();
    setMessages((ms) => [
      ...ms,
      { id: uid(), role: "user", content: message },
      { id: assistantId, role: "assistant", content: "", sources: [], streaming: true, status: "Thinking…" },
    ]);
    setInput("");

    const abort = new AbortController();
    abortRef.current = abort;
    const onEvent = (e: AgentEvent) => {
      switch (e.type) {
        case "status":
          return patch(assistantId, (m) => ({ ...m, status: e.text }));
        case "text":
          return patch(assistantId, (m) => ({ ...m, content: m.content + e.delta }));
        case "sources":
          return patch(assistantId, (m) => ({ ...m, sources: [...(m.sources ?? []), ...e.sources] }));
        case "done":
          return patch(assistantId, (m) => ({
            ...m, content: e.text, sources: e.sources, cited: e.cited, metrics: e.metrics, streaming: false, status: undefined,
          }));
        case "error":
          return patch(assistantId, (m) => ({ ...m, error: e.message, streaming: false, status: undefined }));
      }
    };
    try {
      await streamChat({ message, history, tz }, onEvent, abort.signal);
    } catch (err) {
      const stopped = err instanceof DOMException && err.name === "AbortError";
      patch(assistantId, (m) => ({ ...m, error: stopped ? undefined : String(err instanceof Error ? err.message : err) }));
    } finally {
      patch(assistantId, (m) => (m.streaming ? { ...m, streaming: false, status: undefined } : m));
      abortRef.current = null;
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">Web Agent</div>
        <div className="meta">
          {health ? (
            <>
              <span>{health.model}</span>
              <span>search: {health.search}</span>
              {health.clockOverridden && <span className="warn">clock: {health.now.slice(0, 16).replace("T", " ")}</span>}
            </>
          ) : (
            <span className="warn">server offline</span>
          )}
        </div>
        <button className="ghost" onClick={() => !busy && setMessages([])} disabled={busy || !messages.length}>
          New chat
        </button>
      </header>

      <main className="thread">
        {!messages.length && (
          <div className="empty">
            <h1>Ask about anything current.</h1>
            <p>Answers are searched live and cited.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => void send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="msg user">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className="msg assistant">
              {m.content && <Markdown text={m.content} sources={m.sources ?? []} />}
              {m.streaming && (
                <div className="status">
                  <span className="dot" /> {m.status ?? "Working…"}
                  {!!m.sources?.length && <span className="count"> · {m.sources.length} sources</span>}
                </div>
              )}
              {m.error && <div className="error">{m.error}</div>}
              {!m.streaming && !!m.cited?.length && (
                <ol className="sources">
                  {m.sources!
                    .filter((s) => m.cited!.includes(s.n))
                    .map((s) => (
                      <li key={s.n}>
                        <a href={s.url} target="_blank" rel="noreferrer">
                          <span className="n">{s.n}</span>
                          <span className="title">{s.title}</span>
                          <span className="host">
                            {hostOf(s.url)}
                            {s.publishedAt ? ` · ${s.publishedAt.slice(0, 10)}` : ""}
                          </span>
                        </a>
                      </li>
                    ))}
                </ol>
              )}
              {m.metrics && (
                <div className="metrics">
                  {(m.metrics.totalMs / 1000).toFixed(1)}s · {m.metrics.searchCalls ? `${m.metrics.queries} queries` : "no search"} · {m.metrics.model}
                </div>
              )}
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </main>

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask anything…"
          rows={1}
          autoFocus
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
