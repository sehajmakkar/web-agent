// Phase 0 spike: compare candidate Gemini Flash / Flash-Lite models.
// Run: node --env-file=.env spikes/phase0/models.mjs [model ...]
// Measures: time-to-first-token (TTFT) and total latency, tool-call behaviour (batching / parallel calls),
// relative-date reasoning without help, and structured JSON output (for the extraction role).
// Raw REST calls are deliberate: this is a throwaway probe that runs before any dependency is installed.

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) throw new Error("GEMINI_API_KEY missing");
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"];

const webSearchTool = {
  functionDeclarations: [{
    name: "web_search",
    description: "Search the web. Pass several queries at once when you need several lookups; they run in parallel.",
    parameters: {
      type: "object",
      properties: {
        queries: { type: "array", items: { type: "string" }, description: "1-6 search queries" },
        since: { type: "string", description: "ISO date; only results published after this date" },
      },
      required: ["queries"],
    },
  }],
};

async function stream(model, body) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", ttft = null, text = "", calls = [], usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    // Gemini frames SSE events with CRLF ("\r\n\r\n"); normalise before splitting. (Found the hard way in Phase 0.)
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      for (const p of ev.candidates?.[0]?.content?.parts ?? []) {
        if (p.thought) continue;
        if ((p.text || p.functionCall) && ttft === null) ttft = performance.now() - t0;
        if (p.text) text += p.text;
        if (p.functionCall) calls.push(p.functionCall);
      }
      if (ev.usageMetadata) usage = ev.usageMetadata;
    }
  }
  return { ttft: Math.round(ttft ?? -1), total: Math.round(performance.now() - t0), text: text.trim(), calls, usage };
}

// Gemini 3.x uses thinkingLevel, 2.5 uses thinkingBudget. Try the 3.x form first, fall back.
async function withThinking(model, body, level) {
  let r = await stream(model, { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingLevel: level } } });
  if (r.error) {
    const budget = level === "minimal" ? 0 : level === "low" ? 512 : -1;
    r = await stream(model, { ...body, generationConfig: { ...body.generationConfig, thinkingConfig: { thinkingBudget: budget } } });
    r.thinkingParam = "thinkingBudget";
  } else r.thinkingParam = "thinkingLevel";
  return r;
}

const user = (t) => ({ contents: [{ role: "user", parts: [{ text: t }] }] });

const tests = {
  // 1. Pure latency floor: tiny prompt, no tools.
  hello: (m) => withThinking(m, user("Reply with exactly: OK"), "minimal"),
  // 2. Tool use: does it batch several lookups into one call / emit parallel calls / use `since`?
  tools: (m) => withThinking(m, {
    systemInstruction: { parts: [{ text: "You are a research assistant. Today is Wednesday 2026-11-11. Use web_search for anything time-sensitive." }] },
    ...user("Has pricing changed since 3 November for Neon, Supabase and Render managed Postgres?"),
    tools: [webSearchTool],
  }, "low"),
  // 3. Date reasoning WITHOUT our resolver: is "last Tuesday" handled (and is ambiguity noticed)?
  dates: (m) => withThinking(m, user(
    "Today is Wednesday 11 November 2026. In one line each, give the calendar date for: (a) 'on Monday' (b) 'last Tuesday' (c) '3 November' weekday. Note any ambiguity."), "low"),
  // 4. Structured output for the extraction role.
  extract: (m) => withThinking(m, {
    ...user("Extract claims. Text: 'Neon Launch plan is $19/month (source 1). Supabase Pro is $25/month plus usage (source 2).'"),
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "object",
        properties: { claims: { type: "array", items: { type: "object",
          properties: { entity: { type: "string" }, attribute: { type: "string" }, value: { type: "string" }, source: { type: "integer" } },
          required: ["entity", "attribute", "value", "source"] } } },
        required: ["claims"],
      },
    },
  }, "minimal"),
};

const RUNS = Number(process.env.RUNS ?? 2);
const results = {};
for (const model of MODELS) {
  results[model] = {};
  for (const [name, fn] of Object.entries(tests)) {
    results[model][name] = [];
    for (let run = 1; run <= RUNS; run++) {
      let r;
      try { r = await fn(model); } catch (e) { r = { error: String(e).slice(0, 200) }; }
      results[model][name].push(r);
      const summary = r.error ? `ERROR ${r.error}` :
        `ttft=${r.ttft}ms total=${r.total}ms ${r.thinkingParam} thoughts=${r.usage?.thoughtsTokenCount ?? 0} ` +
        (r.calls.length ? `calls=${JSON.stringify(r.calls.map((c) => c.args))}` : `text=${JSON.stringify(r.text.slice(0, 200))}`);
      console.log(`${model.padEnd(22)} ${name.padEnd(7)} #${run} ${summary}`);
      if (r.error) break;
    }
  }
}
await import("node:fs").then((fs) =>
  fs.writeFileSync(new URL("./models-results.json", import.meta.url), JSON.stringify(results, null, 2)));
