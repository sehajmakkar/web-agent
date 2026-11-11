/**
 * Headless single turn, for debugging and quick checks:
 *   npm run ask -- "What's the latest Node.js release?"
 *   DB_PATH=data/demo.db AGENT_NOW=2026-11-11T10:00:00Z npm run ask -- "What did I ask you on 3 November?"
 * Uses exactly the same runTurn() as the server, with read-only access to DB_PATH memory (nothing is saved).
 * Set ASK_TRACE=1 to print the memory plan.
 */
import fs from "node:fs";
import { runTurn } from "../src/agent/loop.js";
import { openDb } from "../src/db/client.js";
import { getConfig } from "../src/lib/config.js";
import { createChatModel } from "../src/llm/index.js";
import { Store } from "../src/memory/store.js";
import { createSearch } from "../src/search/index.js";

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  console.error('Usage: npm run ask -- "your question"');
  process.exit(1);
}

const config = getConfig();
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
let failed = false;
const store = fs.existsSync(config.DB_PATH) ? new Store(openDb(config.DB_PATH)) : undefined;

await runTurn({
  history: [],
  userText: question,
  tz: config.AGENT_TZ,
  model: createChatModel(config),
  search: createSearch(config),
  memory: store ? { store } : undefined,
  emit: (ev) => {
    switch (ev.type) {
      case "status":
        process.stderr.write(dim(`· ${ev.text}\n`));
        break;
      case "text":
        process.stdout.write(ev.delta);
        break;
      case "reset":
        process.stdout.write(dim("\n[↺ pre-search draft discarded]\n"));
        break;
      case "done": {
        const m = ev.metrics;
        process.stdout.write("\n\n");
        for (const s of ev.sources.filter((x) => ev.cited.includes(x.n)))
          process.stderr.write(dim(`[${s.n}] ${s.title.slice(0, 70)} (${s.publishedAt?.slice(0, 10) ?? "undated"}) ${s.url}\n`));
        if (process.env.ASK_TRACE) process.stderr.write(dim(`\nmemory: ${JSON.stringify(m.memory, null, 1)}\nsearches: ${JSON.stringify(m.searches)}\n`));
        process.stderr.write(
          dim(`\nmodel=${m.model} ttft=${m.ttftMs}ms total=${m.totalMs}ms steps=${m.steps} searches=${m.searchCalls} queries=${m.queries} ` +
            `sources=${ev.sources.length} cited=${ev.cited.length} dropped=[${m.droppedCitations}] ` +
            `tokens in=${m.usage.inputTokens} out=${m.usage.outputTokens} think=${m.usage.thinkingTokens}\n`),
        );
        break;
      }
      case "error":
        failed = true;
        process.stderr.write(`\nERROR (${ev.kind}): ${ev.message}\n`);
        break;
    }
  },
});
process.exit(failed ? 1 : 0);
