import * as HoverCard from "@radix-ui/react-hover-card";
import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "./api";
import { hostOf } from "./util";

const CITE_TITLE = "cite:";

/** Turn [n] / [n][m] / [n, m] into links to the source, leaving real markdown links alone. */
function linkCitations(text: string, sources: Map<number, Source>): string {
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (whole, group: string) => {
    const nums = group.split(",").map((s) => Number(s.trim()));
    if (!nums.every((n) => sources.has(n))) return whole;
    return nums.map((n) => `[${n}](${sources.get(n)!.url} "${CITE_TITLE}${n}")`).join("");
  });
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/**
 * Verdict cells from re-verification tables (ADR-025): the LEADING verdict keyword becomes a colour-coded badge,
 * any explanation after it ("Changed (switched to usage-based) [1]") stays normal text with live citations.
 */
type Verdict = "changed" | "same" | "unknown";
const VERDICT_RE =
  /^\s*(changed|pricing change|major launch|new launch|no change found|no change|unchanged|nothing notable found|nothing notable|couldn[’']?t verify|could not verify|unverified|not verified)\b/i;
function verdictKind(keyword: string): Verdict {
  const k = keyword.toLowerCase();
  if (/^(changed|pricing change|major launch|new launch)/.test(k)) return "changed";
  if (/^(no change|unchanged|nothing notable)/.test(k)) return "same";
  return "unknown";
}

function VerdictCell({ children }: { children: ReactNode }) {
  const kids = Children.toArray(children);
  const first = kids[0];
  const firstText = textOf(first);
  const m = firstText.match(VERDICT_RE);
  if (!m) return <td>{children}</td>;
  const kind = verdictKind(m[1]!);
  if (typeof first === "string") {
    return (
      <td>
        <span className={`verdict v-${kind}`}>{m[1]}</span>
        {first.slice(m[0].length)}
        {kids.slice(1)}
      </td>
    );
  }
  // A <strong>/<em> whose whole text is the keyword ("**Changed** (…)").
  if (firstText.trim().length === m[0].trim().length) {
    return (
      <td>
        <span className={`verdict v-${kind}`}>{m[1]}</span>
        {kids.slice(1)}
      </td>
    );
  }
  return <td>{children}</td>;
}

function Citation({ n, href, source, children }: { n: number; href?: string; source?: Source; children: ReactNode }) {
  const link = (
    <a className="cite" href={href} target="_blank" rel="noreferrer" aria-label={`Source ${n}${source ? `: ${source.title}` : ""}`}>
      {children}
    </a>
  );
  if (!source) return link;
  return (
    <HoverCard.Root openDelay={150} closeDelay={80}>
      <HoverCard.Trigger asChild>{link}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content className="cite-card" sideOffset={6} collisionPadding={12}>
          <div className="cite-card-host">
            <span className="cite-card-n">{n}</span>
            {hostOf(source.url)}
            {source.publishedAt && <span className="cite-card-date"> · {source.publishedAt.slice(0, 10)}</span>}
          </div>
          <div className="cite-card-title">{source.title}</div>
          <div className="cite-card-url">{source.url}</div>
          <HoverCard.Arrow className="cite-card-arrow" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

export function Markdown({ text, sources }: { text: string; sources: Source[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, title, children }) => {
            if (title?.startsWith(CITE_TITLE)) {
              const n = Number(title.slice(CITE_TITLE.length));
              return (
                <Citation n={n} href={href} source={byN.get(n)}>
                  {children}
                </Citation>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" title={title}>
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
          td: ({ children }) => <VerdictCell>{children}</VerdictCell>,
        }}
      >
        {linkCitations(text, byN)}
      </ReactMarkdown>
    </div>
  );
}
