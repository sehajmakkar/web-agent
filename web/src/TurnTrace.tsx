import { CalendarDays, ChevronRight, Clock, History, Search, RefreshCw } from "lucide-react";
import type { Metrics } from "./api";
import { hostOf, seconds, shortDay } from "./util";

/** "From your chat on Tue 3 Nov: …": shown at the top of answers that used memory. */
export function RecallChips({ metrics, onOpen }: { metrics?: Metrics; onOpen: (id: string) => void }) {
  const recalled = metrics?.memory?.recalled ?? [];
  if (!recalled.length) return null;
  return (
    <div className="recall">
      {recalled.map((r) => (
        <button key={r.id} className="recall-chip" onClick={() => onOpen(r.id)} title={r.why}>
          <History size={13} aria-hidden />
          <span className="recall-day">{shortDay(r.localDate)}</span>
          <span className="recall-title">{r.title || "Untitled"}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * "How I answered": the turn trace (ADR-021/024/027), so the architecture is visible in the product:
 * what the code decided (dates, memory, window, pages re-read) versus what the model searched.
 */
export function TurnTrace({ metrics, onOpen }: { metrics: Metrics; onOpen: (id: string) => void }) {
  const mem = metrics.memory;
  const searches = metrics.searches ?? [];
  const prefetch = searches.filter((s) => s.prefetch);
  const modelSearches = searches.filter((s) => !s.prefetch);
  const hasMemory = Boolean(mem && (mem.dates.length || mem.recalled.length || mem.since));

  return (
    <details className="trace">
      <summary>
        <ChevronRight size={14} className="trace-caret" aria-hidden />
        How I answered
        <span className="trace-sum">
          {seconds(metrics.totalMs)}
          {metrics.queries ? ` · ${metrics.queries} quer${metrics.queries === 1 ? "y" : "ies"}` : ""}
          {prefetch.length ? ` · ${prefetch[0]!.urls.length} pages re-read` : ""}
          {!metrics.queries && !prefetch.length ? " · no search" : ""}
          {mem?.recalled.length ? " · used memory" : ""}
        </span>
      </summary>

      <div className="trace-body">
        {hasMemory && mem && (
          <section>
            <h4>
              <CalendarDays size={14} aria-hidden /> Dates & memory <span className="who">decided by code</span>
            </h4>
            <ul>
              {mem.dates.map((d, i) => (
                <li key={i}>
                  “{d.text}” → <strong>{d.resolved ?? d.candidates.join(" or ")}</strong>
                  {d.ambiguous && <span className="tag">{d.resolved ? "ambiguous, resolved" : "ambiguous"}</span>}
                  {d.how && <div className="trace-note">{d.how}</div>}
                </li>
              ))}
              {mem.recalled.map((r) => (
                <li key={r.id}>
                  Recalled{" "}
                  <button className="linkish" onClick={() => onOpen(r.id)}>
                    {shortDay(r.localDate)} · {r.title || "Untitled"}
                  </button>
                  <div className="trace-note">{r.why}</div>
                </li>
              ))}
              {mem.since && (
                <li>
                  Search window: changes since <strong>{shortDay(mem.since)}</strong>
                  {mem.sinceReason && <div className="trace-note">{mem.sinceReason}</div>}
                </li>
              )}
            </ul>
          </section>
        )}

        {prefetch.length > 0 && (
          <section>
            <h4>
              <RefreshCw size={14} aria-hidden /> Pages re-read before answering <span className="who">decided by code</span>
            </h4>
            <ul>
              {prefetch[0]!.urls.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noreferrer">
                    {hostOf(u)}
                    {new URL(u).pathname.replace(/\/$/, "")}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {modelSearches.length > 0 && (
          <section>
            <h4>
              <Search size={14} aria-hidden /> Searches <span className="who">chosen by the model</span>
            </h4>
            <ul>
              {modelSearches.flatMap((s, i) => [
                ...s.queries.map((q) => <li key={`${i}q${q}`}>“{q}”{s.since ? <span className="tag">since {shortDay(s.since)}</span> : null}</li>),
                ...s.urls.map((u) => <li key={`${i}u${u}`}>read {hostOf(u)}</li>),
              ])}
            </ul>
          </section>
        )}

        <section>
          <h4>
            <Clock size={14} aria-hidden /> Timing
          </h4>
          <ul className="inline">
            <li>first text {seconds(metrics.ttftMs)}</li>
            <li>total {seconds(metrics.totalMs)}</li>
            <li>{metrics.steps} model step{metrics.steps === 1 ? "" : "s"}</li>
            <li>{metrics.model}</li>
          </ul>
        </section>
      </div>
    </details>
  );
}
