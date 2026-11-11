import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "./api";

const CITE_TITLE = "cite:";

/** Turn [n] / [n][m] into links to the source, leaving real markdown links alone. */
function linkCitations(text: string, sources: Map<number, Source>): string {
  return text.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (whole, group: string) => {
    const nums = group.split(",").map((s) => Number(s.trim()));
    if (!nums.every((n) => sources.has(n))) return whole;
    return nums.map((n) => `[${n}](${sources.get(n)!.url} "${CITE_TITLE}${n}")`).join("");
  });
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
              const s = byN.get(Number(title.slice(CITE_TITLE.length)));
              return (
                <a className="cite" href={href} target="_blank" rel="noreferrer" title={s ? `${s.title}${s.publishedAt ? ` · ${s.publishedAt.slice(0, 10)}` : ""}` : undefined}>
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="table-wrap">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {linkCitations(text, byN)}
      </ReactMarkdown>
    </div>
  );
}
