import { Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Conversation } from "./api";

/** Group by calendar day relative to the SERVER's "now" (which honours AGENT_NOW), in the viewer's timezone. */
function dayLabel(localDate: string, today: string, yesterday: string): string {
  if (localDate === today) return "Today";
  if (localDate === yesterday) return "Yesterday";
  const d = new Date(`${localDate}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function ymd(date: Date, tz: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function Sidebar(props: {
  conversations: Conversation[];
  activeId: string | null;
  now: Date;
  tz: string;
  open: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const today = ymd(props.now, props.tz);
  const yesterday = ymd(new Date(props.now.getTime() - 86_400_000), props.tz);
  const q = filter.trim().toLowerCase();
  const visible = q
    ? props.conversations.filter((c) => `${c.title} ${c.topics.join(" ")}`.toLowerCase().includes(q))
    : props.conversations;
  const groups = new Map<string, Conversation[]>();
  for (const c of visible) {
    const label = dayLabel(c.localDate, today, yesterday);
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }

  return (
    <aside className={`sidebar${props.open ? " open" : ""}`} aria-label="Conversations">
      <button className="new" onClick={props.onNew}>
        <Plus size={16} aria-hidden /> New chat
      </button>
      {props.conversations.length > 3 && (
        <label className="filter">
          <Search size={14} aria-hidden />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter chats" aria-label="Filter chats" />
        </label>
      )}
      <nav>
        {!props.conversations.length && <p className="hint">Past chats appear here. The agent remembers them by date.</p>}
        {q && !visible.length && <p className="hint">No chats match “{filter}”.</p>}
        {[...groups].map(([label, items]) => (
          <section key={label}>
            <h3>{label}</h3>
            {items.map((c) => (
              <div key={c.id} className={`conv${c.id === props.activeId ? " active" : ""}`}>
                <button className="pick" onClick={() => props.onSelect(c.id)} title={c.title}>
                  {c.title || "Untitled"}
                </button>
                <button className="del" aria-label={`Delete ${c.title || "conversation"}`} onClick={() => props.onDelete(c.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}
