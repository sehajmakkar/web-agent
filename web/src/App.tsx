import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  deleteConversation,
  getConversation,
  getHealth,
  listConversations,
  streamChat,
  type AgentEvent,
  type Conversation,
  type Health,
  type Metrics,
  type Source,
} from "./api";
import { Markdown } from "./Markdown";
import { Sidebar } from "./Sidebar";

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
const hashId = () => new URLSearchParams(location.hash.slice(1)).get("c");

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(hashId());
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Which conversation's messages are on screen. Lets a new chat get its id mid-stream without a reload. */
  const shownIdRef = useRef<string | null>(null);
  const busy = messages.some((m) => m.streaming);

  const refreshList = useCallback(() => listConversations().then(setConversations).catch(() => {}), []);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    void refreshList();
  }, [refreshList]);

  // Load the selected conversation (also on first load from #c=<id>).
  useEffect(() => {
    history.replaceState(null, "", activeId ? `#c=${activeId}` : location.pathname);
    if (!activeId || activeId === shownIdRef.current) return;
    shownIdRef.current = activeId;
    getConversation(activeId)
      .then(({ messages: stored }) =>
        setMessages(
          stored.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            sources: m.sources,
            cited: m.sources.filter((s) => s.cited).map((s) => s.n),
            metrics: m.meta?.metrics,
          })),
        ),
      )
      .catch(() => {
        shownIdRef.current = null;
        setActiveId(null);
        setMessages([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the selection changes
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const patch = (id: string, fn: (m: Message) => Message) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
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
        case "conversation":
          setConversations((cs) => [e.conversation, ...cs.filter((c) => c.id !== e.conversation.id)]);
          shownIdRef.current = e.conversation.id; // already on screen: don't reload it
          setActiveId(e.conversation.id);
          return;
        case "status":
          return patch(assistantId, (m) => ({ ...m, status: e.text }));
        case "text":
          return patch(assistantId, (m) => ({ ...m, content: m.content + e.delta }));
        case "sources":
          return patch(assistantId, (m) => ({ ...m, sources: [...(m.sources ?? []), ...e.sources] }));
        case "done":
          return patch(assistantId, (m) => ({
            ...m, id: e.messageId, content: e.text, sources: e.sources, cited: e.cited, metrics: e.metrics, streaming: false, status: undefined,
          }));
        case "error":
          return patch(assistantId, (m) => ({ ...m, error: e.message, streaming: false, status: undefined }));
      }
    };
    try {
      await streamChat({ conversationId: activeId ?? undefined, message, tz }, onEvent, abort.signal);
    } catch (err) {
      const stopped = err instanceof DOMException && err.name === "AbortError";
      patch(assistantId, (m) => ({ ...m, error: stopped ? undefined : String(err instanceof Error ? err.message : err) }));
    } finally {
      patch(assistantId, (m) => (m.streaming ? { ...m, streaming: false, status: undefined } : m));
      abortRef.current = null;
    }
  }

  const select = (id: string) => {
    if (busy) return;
    setSidebarOpen(false);
    if (id === activeId) return;
    setMessages([]);
    setActiveId(id);
  };
  const newChat = () => {
    if (busy) return;
    setSidebarOpen(false);
    setMessages([]);
    setActiveId(null);
    shownIdRef.current = null;
  };
  const remove = async (id: string) => {
    if (busy || !confirm("Delete this conversation?")) return;
    await deleteConversation(id).catch(() => {});
    if (id === activeId) newChat();
    void refreshList();
  };

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

  const serverNow = health ? new Date(health.now) : new Date();

  return (
    <div className="layout">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        now={serverNow}
        tz={tz}
        open={sidebarOpen}
        onSelect={select}
        onNew={newChat}
        onDelete={(id) => void remove(id)}
      />
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <div className="app">
        <header className="top">
          <button className="ghost menu" onClick={() => setSidebarOpen((o) => !o)} aria-label="Conversations">
            ☰
          </button>
          <div className="brand">Web Agent</div>
          <div className="meta">
            {health ? (
              <>
                <span>{health.model}</span>
                <span>search: {health.search}</span>
                {health.clockOverridden && (
                  <span className="warn">demo clock: {serverNow.toLocaleString("en-GB", { timeZone: tz, dateStyle: "medium", timeStyle: "short" })}</span>
                )}
              </>
            ) : (
              <span className="warn">server offline</span>
            )}
          </div>
        </header>

        <main className="thread">
          {!messages.length && (
            <div className="empty">
              <h1>Ask about anything current.</h1>
              <p>Answers are searched live and cited. Conversations are remembered.</p>
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
