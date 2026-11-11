// Phase 0 spike: Tavily vs Exa on queries shaped like the assignment's test cases.
// Run: node --env-file=.env spikes/phase0/search.mjs
// For each query x config it records: latency, #results, whether a primary-source domain is in the top 3,
// how many results carry a published date, newest date, whether a `since` filter was honoured, content size.
// It also tests re-reading a known URL (Tavily /extract vs Exa /contents), needed for re-verification (C8).

import fs from "node:fs";

const TAVILY = process.env.TAVILY_API_KEY, EXA = process.env.EXA_API_KEY;
if (!TAVILY || !EXA) throw new Error("TAVILY_API_KEY and EXA_API_KEY required");

// kind: pricing (primary page should win) | since (date-bounded change detection) | fresh (recent events) | fact
const QUERIES = [
  { q: "Neon serverless Postgres pricing plans", kind: "pricing", primary: "neon.com|neon.tech" },
  { q: "Supabase pricing Pro plan", kind: "pricing", primary: "supabase.com" },
  { q: "Render managed Postgres pricing", kind: "pricing", primary: "render.com" },
  { q: "HubSpot Sales Hub pricing per seat", kind: "pricing", primary: "hubspot.com" },
  { q: "Pipedrive pricing plans", kind: "pricing", primary: "pipedrive.com" },
  { q: "Close CRM pricing", kind: "pricing", primary: "close.com" },
  { q: "Neon Postgres changelog", kind: "since", primary: "neon.com|neon.tech", since: "2026-10-15" },
  { q: "Supabase new features announcement", kind: "since", primary: "supabase.com", since: "2026-10-15" },
  { q: "HubSpot pricing change", kind: "since", primary: "hubspot.com", since: "2026-10-01" },
  { q: "Salesforce Sales Cloud announcement", kind: "since", primary: "salesforce.com", since: "2026-10-15" },
  { q: "Pipedrive new feature launch", kind: "since", primary: "pipedrive.com", since: "2026-10-01" },
  { q: "latest Node.js release", kind: "fresh", primary: "nodejs.org|github.com" },
  { q: "AI news this week", kind: "fresh", primary: "" },
  { q: "PostgreSQL latest major version release", kind: "fact", primary: "postgresql.org" },
  { q: "Zoho CRM pricing for 20 users", kind: "pricing", primary: "zoho.com" },
];
const EXTRACT_URLS = ["https://neon.com/pricing", "https://supabase.com/pricing"];

const now = () => performance.now();
async function post(url, headers, body) {
  const t0 = now();
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
  const ms = Math.round(now() - t0);
  const text = await res.text();
  if (!res.ok) return { ms, error: `${res.status} ${text.slice(0, 160)}` };
  return { ms, json: JSON.parse(text) };
}

const CONFIGS = {
  "tavily-basic": (x) => post("https://api.tavily.com/search", { authorization: `Bearer ${TAVILY}` }, {
    query: x.q, search_depth: "basic", max_results: 5,
    ...(x.since ? { start_date: x.since, topic: "general" } : {}),
  }),
  "tavily-advanced": (x) => post("https://api.tavily.com/search", { authorization: `Bearer ${TAVILY}` }, {
    query: x.q, search_depth: "advanced", max_results: 5, include_raw_content: false,
    ...(x.since ? { start_date: x.since } : {}),
  }),
  "exa-auto": (x) => post("https://api.exa.ai/search", { "x-api-key": EXA }, {
    query: x.q, type: "auto", numResults: 5, contents: { text: { maxCharacters: 3000 }, highlights: true },
    ...(x.since ? { startPublishedDate: `${x.since}T00:00:00.000Z` } : {}),
  }),
  "exa-fast": (x) => post("https://api.exa.ai/search", { "x-api-key": EXA }, {
    query: x.q, type: "fast", numResults: 5, contents: { text: { maxCharacters: 3000 } },
    ...(x.since ? { startPublishedDate: `${x.since}T00:00:00.000Z` } : {}),
  }),
};

function normalise(config, json) {
  const rs = json.results ?? [];
  return rs.map((r) => ({
    url: r.url, title: r.title,
    published: r.published_date ?? r.publishedDate ?? null,
    chars: (r.content ?? r.text ?? "").length + (r.raw_content ?? "").length,
  }));
}

const rows = [];
for (const x of QUERIES) {
  for (const [name, run] of Object.entries(CONFIGS)) {
    let r;
    try { r = await run(x); } catch (e) { r = { ms: -1, error: String(e).slice(0, 160) }; }
    if (r.error) { rows.push({ q: x.q, kind: x.kind, config: name, ms: r.ms, error: r.error }); console.log(name, x.q, "ERROR", r.error); continue; }
    const res = normalise(name, r.json);
    const re = x.primary ? new RegExp(x.primary.replace(/\./g, "\\.")) : null;
    const dated = res.filter((z) => z.published);
    const newest = dated.map((z) => z.published).sort().at(-1) ?? null;
    const row = {
      q: x.q, kind: x.kind, config: name, ms: r.ms, n: res.length,
      primaryTop3: re ? res.slice(0, 3).some((z) => re.test(z.url)) : null,
      dated: dated.length, newest: newest?.slice(0, 10) ?? null,
      sinceViolations: x.since ? dated.filter((z) => z.published.slice(0, 10) < x.since).length : null,
      avgChars: res.length ? Math.round(res.reduce((a, z) => a + z.chars, 0) / res.length) : 0,
      top: res.slice(0, 3).map((z) => z.url),
    };
    rows.push(row);
    console.log(`${name.padEnd(15)} ${String(row.ms).padStart(5)}ms n=${row.n} primary=${row.primaryTop3} dated=${row.dated} newest=${row.newest} sinceViol=${row.sinceViolations} chars=${row.avgChars} | ${x.q}`);
  }
}

// Re-read known URLs (re-verification path).
const extract = [];
for (const url of EXTRACT_URLS) {
  const t = await post("https://api.tavily.com/extract", { authorization: `Bearer ${TAVILY}` }, { urls: [url] });
  const tChars = t.json?.results?.[0]?.raw_content?.length ?? 0;
  const e = await post("https://api.exa.ai/contents", { "x-api-key": EXA }, { urls: [url], text: true, livecrawl: "always" });
  const eChars = e.json?.results?.[0]?.text?.length ?? 0;
  extract.push({ url, tavily: { ms: t.ms, chars: tChars, error: t.error }, exa: { ms: e.ms, chars: eChars, error: e.error } });
  console.log(`extract ${url} tavily ${t.ms}ms ${tChars}ch ${t.error ?? ""} | exa(livecrawl) ${e.ms}ms ${eChars}ch ${e.error ?? ""}`);
}

// Aggregate per config.
const summary = {};
for (const name of Object.keys(CONFIGS)) {
  const rs = rows.filter((r) => r.config === name && !r.error);
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  const withPrimary = rs.filter((r) => r.primaryTop3 !== null);
  const sinceRows = rs.filter((r) => r.sinceViolations !== null);
  summary[name] = {
    ok: rs.length, errors: rows.filter((r) => r.config === name && r.error).length,
    p50ms: ms[Math.floor(ms.length / 2)], p90ms: ms[Math.floor(ms.length * 0.9)],
    primaryTop3: `${withPrimary.filter((r) => r.primaryTop3).length}/${withPrimary.length}`,
    datedShare: `${rs.reduce((a, r) => a + r.dated, 0)}/${rs.reduce((a, r) => a + r.n, 0)}`,
    sinceViolations: sinceRows.reduce((a, r) => a + r.sinceViolations, 0),
    avgChars: Math.round(rs.reduce((a, r) => a + r.avgChars, 0) / (rs.length || 1)),
  };
}
console.table(summary);
fs.writeFileSync(new URL("./search-results.json", import.meta.url), JSON.stringify({ rows, extract, summary }, null, 2));
