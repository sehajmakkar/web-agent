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
  const today = ymd(props.now, props.tz);
  const yesterday = ymd(new Date(props.now.getTime() - 86_400_000), props.tz);
  const groups = new Map<string, Conversation[]>();
  for (const c of props.conversations) {
    const label = dayLabel(c.localDate, today, yesterday);
    groups.set(label, [...(groups.get(label) ?? []), c]);
  }

  return (
    <aside className={`sidebar${props.open ? " open" : ""}`}>
      <button className="new" onClick={props.onNew}>
        + New chat
      </button>
      <nav>
        {!props.conversations.length && <p className="hint">Past chats appear here.</p>}
        {[...groups].map(([label, items]) => (
          <section key={label}>
            <h3>{label}</h3>
            {items.map((c) => (
              <div key={c.id} className={`conv${c.id === props.activeId ? " active" : ""}`}>
                <button className="pick" onClick={() => props.onSelect(c.id)} title={c.title}>
                  {c.title || "Untitled"}
                </button>
                <button className="del" aria-label="Delete conversation" onClick={() => props.onDelete(c.id)}>
                  ×
                </button>
              </div>
            ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}
