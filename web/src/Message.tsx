import { AlertCircle, Check, Copy, RotateCcw } from "lucide-react";
import { useState } from "react";
import type { Metrics, Source } from "./api";
import { Markdown } from "./Markdown";
import { RecallChips, TurnTrace } from "./TurnTrace";
import { hostOf } from "./util";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  cited?: number[];
  /** Every status line this turn, in order (the last one is live while streaming). */
  steps?: string[];
  error?: string;
  metrics?: Metrics;
  streaming?: boolean;
}

export function UserMessage({ m }: { m: ChatMessage }) {
  return <div className="msg user">{m.content}</div>;
}

export function AssistantMessage({ m, onOpen, onRetry }: { m: ChatMessage; onOpen: (id: string) => void; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const [allSources, setAllSources] = useState(false);
  const cited = (m.sources ?? []).filter((s) => m.cited?.includes(s.n));
  const uncited = (m.sources?.length ?? 0) - cited.length;
  const SOURCE_PREVIEW = 6;
  const shown = allSources ? cited : cited.slice(0, SOURCE_PREVIEW);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. insecure context) */
    }
  };

  return (
    <div className="msg assistant" aria-busy={m.streaming}>
      <RecallChips metrics={m.metrics} onOpen={onOpen} />

      {m.streaming && !m.content && <Progress steps={m.steps ?? []} sources={m.sources?.length ?? 0} />}
      {m.content && <Markdown text={m.content} sources={m.sources ?? []} />}
      {m.streaming && m.content && <div className="typing" aria-hidden />}

      {m.error && (
        <div className="error" role="alert">
          <AlertCircle size={16} aria-hidden />
          <span>{m.error}</span>
          {onRetry && (
            <button className="ghost small" onClick={onRetry}>
              <RotateCcw size={13} aria-hidden /> Retry
            </button>
          )}
        </div>
      )}

      {!m.streaming && cited.length > 0 && (
        <ol className="sources" aria-label="Sources">
          {shown.map((s) => (
            <li key={s.n}>
              <a href={s.url} target="_blank" rel="noreferrer" title={`${s.title}${s.publishedAt ? ` · published ${s.publishedAt.slice(0, 10)}` : ""}`}>
                <span className="n">{s.n}</span>
                <span className="title">{s.title}</span>
                <span className="host">{hostOf(s.url)}</span>
              </a>
            </li>
          ))}
          {cited.length > SOURCE_PREVIEW && (
            <li>
              <button className="more-btn" onClick={() => setAllSources((v) => !v)}>
                {allSources ? "Show fewer" : `Show all ${cited.length}`}
              </button>
            </li>
          )}
          {uncited > 0 && <li className="more">+{uncited} read, not cited</li>}
        </ol>
      )}

      {!m.streaming && m.content && (
        <div className="msg-foot">
          {m.metrics && <TurnTrace metrics={m.metrics} onOpen={onOpen} />}
          <button className="icon" onClick={() => void copy()} aria-label="Copy answer" title="Copy answer">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      )}
    </div>
  );
}

/** Live progress while nothing has been written yet: each status line becomes a step. */
function Progress({ steps, sources }: { steps: string[]; sources: number }) {
  const list = steps.length ? steps : ["Thinking…"];
  return (
    <ol className="progress" aria-live="polite">
      {list.map((s, i) => (
        <li key={i} className={i === list.length - 1 ? "live" : "done"}>
          <span className="dot" aria-hidden />
          {s}
          {i === list.length - 1 && sources > 0 && <span className="count"> · {sources} sources</span>}
        </li>
      ))}
    </ol>
  );
}
