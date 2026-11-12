/**
 * Eval runner (docs/EVALS.md).
 *
 *   npm run eval                                  all scenarios, configured model, live search
 *   npm run eval -- --filter B1,C1                only these (prefix match on id)
 *   npm run eval -- --from C1                     resume from a scenario (e.g. after rotating a key)
 *   npm run eval -- --model gemini-3.5-flash      compare models (fallbacks off, so we measure exactly this model)
 *   npm run eval -- --thinking medium             compare thinking levels
 *   npm run eval -- --runs 3                      repeat each scenario (p50/p90 get meaningful)
 *   npm run eval -- --judge                       add an LLM-judge score (1-5) from each scenario's rubric
 *   npm run eval -- --record-search               reuse recorded search results for identical queries
 *   npm run eval -- --label baseline              name the results file
 *
 * Each scenario runs in isolation: fresh in-memory DB, seeded fixtures, clock anchored at the scenario's "now".
 * A quota error stops the run and prints the --from command to resume (keys are rotated by hand).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { runTurn } from "../src/agent/loop.js";
import type { AgentEvent } from "../src/agent/types.js";
import { openDb } from "../src/db/client.js";
import { setNow } from "../src/lib/clock.js";
import { getConfig } from "../src/lib/config.js";
import { createChatModel } from "../src/llm/index.js";
import { generateJson } from "../src/llm/json.js";
import type { ModelClient } from "../src/llm/types.js";
import { loadSeedSet, seed } from "../src/memory/seed.js";
import { Store } from "../src/memory/store.js";
import { createSearch } from "../src/search/index.js";
import type { SearchProvider } from "../src/search/types.js";
import { percentile, runChecks, type CheckResult, type TurnOutcome } from "./checks.js";
import { FailingSearch, FixtureSearch, RecordingSearch } from "./searchDoubles.js";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const { values: args } = parseArgs({
  options: {
    filter: { type: "string" }, from: { type: "string" }, model: { type: "string" }, thinking: { type: "string" },
    runs: { type: "string", default: "1" }, judge: { type: "boolean", default: false }, "record-search": { type: "boolean", default: false },
    label: { type: "string" },
  },
});

// ---- scenarios ----
const Hit = z.object({ url: z.string(), title: z.string(), content: z.string(), publishedAt: z.string().optional() });
const Scenario = z.object({
  id: z.string(),
  family: z.string(),
  seed: z.string().nullable().optional(),
  now: z.string().optional(),
  tz: z.string().optional(),
  search: z.literal("fail").optional(),
  search_hits: z.array(Hit).optional(),
  turns: z.array(z.object({ user: z.string() })).min(1),
  expect: z.record(z.string(), z.unknown()).default({}),
  judge: z.string().optional(),
});
type Scenario = z.infer<typeof Scenario>;
const file = parse(fs.readFileSync(path.join(ROOT, "scenarios.yaml"), "utf8")) as { defaults: { now: string; tz: string }; scenarios: unknown[] };
let scenarios = file.scenarios.map((s) => Scenario.parse(s));
if (args.filter) {
  const wanted = args.filter.split(",").map((s) => s.trim());
  scenarios = scenarios.filter((s) => wanted.some((w) => s.id.startsWith(w)));
}
if (args.from) {
  const i = scenarios.findIndex((s) => s.id.startsWith(args.from!));
  if (i < 0) throw new Error(`--from ${args.from}: no such scenario`);
  scenarios = scenarios.slice(i);
}

// ---- system under test ----
const config = getConfig();
const modelName = args.model ?? config.GEMINI_MODEL;
const thinking = (args.thinking ?? config.GEMINI_THINKING_LEVEL) as typeof config.GEMINI_THINKING_LEVEL;
const model: ModelClient = createChatModel({ ...config, GEMINI_MODEL: modelName, GEMINI_FALLBACK_MODELS: [], GEMINI_THINKING_LEVEL: thinking });
const judgeModel: ModelClient = createChatModel({ ...config, GEMINI_MODEL: config.GEMINI_EXTRACT_MODEL, GEMINI_FALLBACK_MODELS: [], GEMINI_THINKING_LEVEL: "low" });
const liveSearch = createSearch(config);
const recording = args["record-search"] ? new RecordingSearch(liveSearch, path.join(ROOT, "recordings", "search.json")) : null;
const fixturesFile = path.join(ROOT, "fixtures", "history.yaml");

class QuotaStop extends Error {}

interface TurnRecord extends TurnOutcome {
  user: string;
  checks: CheckResult[];
}
interface ScenarioResult {
  id: string;
  family: string;
  run: number;
  turns: TurnRecord[];
  pass: boolean;
  judge?: { score: number; reason: string };
}

async function runScenario(s: Scenario, run: number): Promise<ScenarioResult> {
  setNow(s.now ?? file.defaults.now);
  const tz = s.tz ?? file.defaults.tz;
  const store = new Store(openDb(":memory:"));
  if (s.seed) seed(store, loadSeedSet(fixturesFile, s.seed));
  const search: SearchProvider = s.search === "fail"
    ? new FailingSearch()
    : s.search_hits
      ? new FixtureSearch(s.search_hits.map((h) => ({ ...h, provider: "fixture" })))
      : recording ?? liveSearch;
  const conv = store.createConversation({ tz });
  const history: { role: "user" | "assistant"; content: string }[] = [];
  const turns: TurnRecord[] = [];

  for (const [i, turn] of s.turns.entries()) {
    store.appendMessage({ conversationId: conv.id, role: "user", content: turn.user });
    const out: TurnOutcome = { text: "", sources: [], cited: [] };
    const emit = (e: AgentEvent) => {
      if (e.type === "done") Object.assign(out, { text: e.text, sources: e.sources, cited: e.cited, metrics: e.metrics });
      if (e.type === "error") out.error = { kind: e.kind, message: e.message };
    };
    await runTurn({ history: [...history], userText: turn.user, tz, model, search, emit, memory: { store, currentConversationId: conv.id } });
    if (out.error?.kind === "quota") throw new QuotaStop(out.error.message);
    if (out.text) {
      store.appendMessage({ conversationId: conv.id, role: "assistant", content: out.text, sources: out.sources.map((source) => ({ source, cited: out.cited.includes(source.n) })) });
      history.push({ role: "user", content: turn.user }, { role: "assistant", content: out.text });
    }
    const turnKey = `turn${i + 1}`;
    const expect = i === 0
      ? Object.fromEntries(Object.entries(s.expect).filter(([k]) => !/^turn\d+$/.test(k)))
      : ((s.expect[turnKey] as Record<string, unknown> | undefined) ?? {});
    turns.push({ user: turn.user, ...out, checks: runChecks(expect, out, { isCold: !s.seed }) });
  }

  const result: ScenarioResult = { id: s.id, family: s.family, run, turns, pass: turns.every((t) => t.checks.every((c) => c.pass)) };
  if (args.judge && s.judge) result.judge = await judge(s, turns);
  return result;
}

const JudgeOut = z.object({ score: z.number().int().min(1).max(5), reason: z.string() });
async function judge(s: Scenario, turns: TurnRecord[]): Promise<{ score: number; reason: string }> {
  const transcript = turns.map((t) => `USER: ${t.user}\nASSISTANT: ${t.text || `(error: ${t.error?.message})`}`).join("\n\n");
  try {
    const { value } = await generateJson(judgeModel, {
      // Phase 5: the first judge pass gave 5/5 to an answer that silently ignored an ambiguity ("handled it in zero
      // sentences"), so the instructions now forbid crediting behaviour the transcript doesn't show.
      system:
        "You grade a research assistant's answer against a rubric. Be strict and literal. Check each requirement in the rubric " +
        "against the transcript; give credit only for what the answer visibly does. If any requirement is missed, the score is at most 3. " +
        "Score 1 (fails) to 5 (meets every requirement). Reason: one sentence naming the deciding requirement.",
      prompt: `<rubric>\n${s.judge}\n</rubric>\n\n<transcript>\n${transcript}\n</transcript>`,
      jsonSchema: { type: "object", properties: { score: { type: "integer" }, reason: { type: "string" } }, required: ["score", "reason"] },
      schema: JudgeOut,
    });
    return value;
  } catch (err) {
    if (err instanceof Error && /quota/i.test(err.message)) throw new QuotaStop(err.message);
    return { score: 0, reason: `judge failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---- run ----
const runs = Number(args.runs);
const label = args.label ?? `${modelName}${args.thinking ? `-${thinking}` : ""}`;
console.log(`\nEval · ${scenarios.length} scenario(s) × ${runs} · model=${modelName} thinking=${thinking} · search=${recording ? "recording" : liveSearch.name}${args.judge ? " · judge" : ""}\n`);

const results: ScenarioResult[] = [];
let stopped: string | undefined;
outer: for (let run = 1; run <= runs; run++) {
  for (const s of scenarios) {
    try {
      const r = await runScenario(s, run);
      results.push(r);
      const last = r.turns.at(-1)!;
      const failed = r.turns.flatMap((t) => t.checks.filter((c) => !c.pass));
      const checks = r.turns.flatMap((t) => t.checks);
      console.log(
        `${r.pass ? "✓" : "✗"} ${s.id.padEnd(34)} ${`${checks.length - failed.length}/${checks.length}`.padStart(5)}  ` +
          `${((last.metrics?.totalMs ?? 0) / 1000).toFixed(1).padStart(5)}s  searches=${last.metrics?.searches.length ?? 0}` +
          (r.judge ? `  judge=${r.judge.score}` : "") +
          (failed.length ? `\n    ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("\n    ")}` : ""),
      );
    } catch (err) {
      if (err instanceof QuotaStop) {
        stopped = s.id;
        console.log(`\n⚠ QUOTA hit at ${s.id}: ${err.message}\n  Rotate the key in .env, then resume with:  npm run eval -- --from ${s.id}${args.model ? ` --model ${args.model}` : ""}${args.judge ? " --judge" : ""}\n`);
        break outer;
      }
      throw err;
    }
  }
}
recording?.save();
setNow(null);

// ---- summary ----
const totals = results.map((r) => r.turns.at(-1)?.metrics?.totalMs ?? NaN);
const ttfts = results.map((r) => r.turns.at(-1)?.metrics?.ttftMs ?? NaN);
const families = [...new Set(results.map((r) => r.family))].sort();
const byFamily = families.map((f) => {
  const rs = results.filter((r) => r.family === f);
  return `${f} ${rs.filter((r) => r.pass).length}/${rs.length}`;
});
const judged = results.filter((r) => r.judge && r.judge.score > 0);
const summary = {
  label, model: modelName, thinking, runs, scenarios: results.length,
  passed: results.filter((r) => r.pass).length,
  checks: { total: results.flatMap((r) => r.turns.flatMap((t) => t.checks)).length, passed: results.flatMap((r) => r.turns.flatMap((t) => t.checks)).filter((c) => c.pass).length },
  byFamily,
  latency: { p50: percentile(totals, 50), p90: percentile(totals, 90), ttftP50: percentile(ttfts, 50), ttftP90: percentile(ttfts, 90) },
  judgeMean: judged.length ? Number((judged.reduce((a, r) => a + r.judge!.score, 0) / judged.length).toFixed(2)) : null,
  searchRecording: recording ? { hits: recording.hits, misses: recording.misses } : undefined,
  stoppedAt: stopped,
};
console.log(`\n${summary.passed}/${summary.scenarios} scenarios · ${summary.checks.passed}/${summary.checks.total} checks · by family: ${byFamily.join("  ")}`);
console.log(`latency p50 ${((summary.latency.p50 ?? 0) / 1000).toFixed(1)}s · p90 ${((summary.latency.p90 ?? 0) / 1000).toFixed(1)}s · first text p50 ${((summary.latency.ttftP50 ?? 0) / 1000).toFixed(1)}s${summary.judgeMean ? ` · judge mean ${summary.judgeMean}` : ""}`);

const outDir = path.join(ROOT, "results");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(outDir, `${stamp}-${label.replace(/[^\w.-]/g, "_")}.json`);
fs.writeFileSync(outFile, JSON.stringify({ summary, results }, null, 1));
console.log(`results → ${path.relative(process.cwd(), outFile)}\n`);
process.exit(stopped ? 2 : 0);
