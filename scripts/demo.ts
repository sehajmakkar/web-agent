/**
 * `npm run demo`: reseed the demo database and start the app "time-travelled" to the fixtures' reference moment
 * (Wed 11 Nov 2026, 10:00 Europe/London), so the assignment's example prompts work verbatim:
 *   "What did I ask you on 3 November?"   "On Monday we shortlisted 5 CRM tools…"   "Last Tuesday I asked about Postgres hosting…"
 * Your normal database (data/agent.db) is untouched.
 */
import { spawn } from "node:child_process";
import { DEMO_DB, seedDemo } from "./seed-demo.js";

// Own ports, so the demo can run next to a normal `npm run dev` (8787/5173).
const PORT = "8790";
const WEB_PORT = "5180";

const r = seedDemo();
console.log(`[demo] seeded ${r.conversations} conversations into ${r.db}; clock anchored at 2026-11-11 10:00 Europe/London`);
console.log(`[demo] open http://localhost:${WEB_PORT}`);

const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, DB_PATH: DEMO_DB, AGENT_NOW: "2026-11-11T10:00:00Z", AGENT_TZ: "Europe/London", PORT, WEB_PORT },
});
child.on("exit", (code) => process.exit(code ?? 0));
