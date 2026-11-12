import { ArrowUp, Menu, Square } from "lucide-react";
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
} from "./api";
import { AssistantMessage, UserMessage, type ChatMessage } from "./Message";
import { Sidebar } from "./Sidebar";

/** The assignment's own examples first: they exercise memory + time + change. */
const MEMORY_PROMPTS = [
  "What did I ask you on 3 November? Is your answer still correct today?",
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
];
const GENERAL_PROMPTS = [
  "What's the latest Node.js release and what's new in it?",
  "Compare Neon, Supabase and Render for managed Postgres pricing",
];

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const uid = () => Math.random().toString(36).slice(2);
const hashId = () => new URLSearchParams(location.hash.slice(1)).get("c");

export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(hashId());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** Which conversation's messages are on screen. Lets a new chat get its id mid-stream without a reload. */
  const shownIdRef = useRef<string | null>(null);
  const busy = messages.some((m) => m.streaming);

  const refreshList = useCallback(() => listConversations().then(setConversations).catch(() => {}), []);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
      .finally(() => setHealthLoaded(true));
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
  }, [activeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  // Auto-grow the composer (fallback for browsers without CSS field-sizing).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  async function send(text: string, opts: { replaceErrored?: string } = {}) {
    const message = text.trim();
    if (!message || busy) return;
    const assistantId = uid();
    setMessages((ms) => [
      ...(opts.replaceErrored ? ms.filter((m) => m.id !== opts.replaceErrored) : [...ms, { id: uid(), role: "user" as const, content: message }]),
      { id: assistantId, role: "assistant", content: "", sources: [], streaming: true, steps: [] },
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
          return patch(assistantId, (m) => ({ ...m, steps: [...(m.steps ?? []), e.text] }));
        case "text":
          return patch(assistantId, (m) => ({ ...m, content: m.content + e.delta }));
        case "reset": // ADR-024: a pre-search draft is not the answer
          return patch(assistantId, (m) => ({ ...m, content: "" }));
        case "sources":
          return patch(assistantId, (m) => ({ ...m, sources: [...(m.sources ?? []), ...e.sources] }));
        case "done":
          return patch(assistantId, (m) => ({
            ...m, id: e.messageId, content: e.text, sources: e.sources, cited: e.cited, metrics: e.metrics, streaming: false,
          }));
        case "error":
          return patch(assistantId, (m) => ({ ...m, error: e.message, streaming: false }));
      }
    };
    try {
      await streamChat({ conversationId: activeId ?? undefined, message, tz }, onEvent, abort.signal);
    } catch (err) {
      const stopped = err instanceof DOMException && err.name === "AbortError";
      patch(assistantId, (m) => ({ ...m, error: stopped ? (m.content ? undefined : "Stopped.") : String(err instanceof Error ? err.message : err) }));
    } finally {
      patch(assistantId, (m) => (m.streaming ? { ...m, streaming: false } : m));
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  /** Retry re-asks the question that preceded a failed answer, in place. */
  const retry = (assistantId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantId);
    const question = [...messages.slice(0, idx)].reverse().find((m) => m.role === "user");
    if (question) void send(question.content, { replaceErrored: assistantId });
  };

  const open = (id: string) => {
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
    inputRef.current?.focus();
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
    if (e.key === "Escape" && busy) abortRef.current?.abort();
  };

  const serverNow = health ? new Date(health.now) : new Date();
  const demo = Boolean(health?.clockOverridden);

  return (
    <div className="layout">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        now={serverNow}
        tz={tz}
        open={sidebarOpen}
        onSelect={open}
        onNew={newChat}
        onDelete={(id) => void remove(id)}
      />
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <div className="app">
        <header className="top">
          <button className="icon menu" onClick={() => setSidebarOpen((o) => !o)} aria-label="Conversations">
            <Menu size={18} />
          </button>
          <div className="brand">Web Agent</div>
          <div className="meta">
            {health ? (
              <>
                <span className="pill">{health.model}</span>
                <span className="pill">search: {health.search}</span>
              </>
            ) : (
              healthLoaded && <span className="pill warn">server offline</span>
            )}
          </div>
        </header>

        {demo && (
          <div className="banner" role="note">
            Demo clock: <strong>{serverNow.toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</strong>
            {" "}· backdated history loaded (3, 9 and 10 Nov), so the examples below work word for word.
          </div>
        )}

        <main className="thread">
          {!messages.length && (
            <div className="empty">
              <h1>Ask about anything current.</h1>
              <p>Live web search with citations, and memory of what we discussed and when.</p>
              <h2>Memory, time and change</h2>
              <div className="suggestions">
                {MEMORY_PROMPTS.map((s) => (
                  <button key={s} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
              <h2>Anything current</h2>
              <div className="suggestions">
                {GENERAL_PROMPTS.map((s) => (
                  <button key={s} onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} m={m} />
            ) : (
              <AssistantMessage key={m.id} m={m} onOpen={open} onRetry={m.error ? () => retry(m.id) : undefined} />
            ),
          )}
          <div ref={bottomRef} />
        </main>

        <form className="composer" onSubmit={onSubmit}>
          <div className="composer-box">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask anything…"
              rows={1}
              autoFocus
              aria-label="Message"
            />
            {busy ? (
              <button type="button" className="send stop" onClick={() => abortRef.current?.abort()} aria-label="Stop">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className="send" disabled={!input.trim()} aria-label="Send">
                <ArrowUp size={18} />
              </button>
            )}
          </div>
          <div className="hint">Enter to send · Shift+Enter for a new line · Esc to stop</div>
        </form>
      </div>
    </div>
  );
}
