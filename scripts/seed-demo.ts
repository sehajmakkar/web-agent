/**
 * Seed backdated demo history (evals/fixtures/history.yaml) into a SEPARATE database (ADR-009),
 * so a reviewer's real conversations are never mixed with fixtures.
 *
 *   npm run seed:demo                      → data/demo.db, seed set "base", resets its contents in place
 *   npm run seed:demo -- --set ambiguous_tuesday --db data/other.db
 */
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openDb } from "../src/db/client.js";
import { loadSeedSet, seed } from "../src/memory/seed.js";
import { Store } from "../src/memory/store.js";

export const DEMO_DB = "data/demo.db";
export const FIXTURES = "evals/fixtures/history.yaml";

export function seedDemo(opts: { db?: string; set?: string } = {}) {
  const db = opts.db ?? DEMO_DB;
  // Reset IN PLACE (one transaction) instead of deleting the file: a running demo server keeps the file open, and
  // deleting it would leave that server reading a stale, unlinked copy. (Found in Phase 3; see CHALLENGES C22.)
  const store = new Store(openDb(db));
  store.db.transaction(() => {
    store.db.exec(`DELETE FROM conversations; DELETE FROM sources WHERE id NOT IN (SELECT source_id FROM message_sources);`);
  })();
  const result = seed(store, loadSeedSet(FIXTURES, opts.set ?? "base"));
  store.db.close();
  return { db, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { db: { type: "string" }, set: { type: "string" } } });
  const r = seedDemo({ db: values.db, set: values.set });
  console.log(`Seeded ${r.conversations} conversations / ${r.messages} messages into ${r.db}`);
}
