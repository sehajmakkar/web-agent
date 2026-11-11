/**
 * Seed backdated demo history (evals/fixtures/history.yaml) into a SEPARATE database (ADR-009),
 * so a reviewer's real conversations are never mixed with fixtures.
 *
 *   npm run seed:demo                      → data/demo.db, seed set "base", wipes the file first
 *   npm run seed:demo -- --set ambiguous_tuesday --db data/other.db
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { openDb } from "../src/db/client.js";
import { loadSeedSet, seed } from "../src/memory/seed.js";
import { Store } from "../src/memory/store.js";

export const DEMO_DB = "data/demo.db";
export const FIXTURES = "evals/fixtures/history.yaml";

export function seedDemo(opts: { db?: string; set?: string } = {}) {
  const db = opts.db ?? DEMO_DB;
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${db}${suffix}`, { force: true });
  const store = new Store(openDb(db));
  const result = seed(store, loadSeedSet(FIXTURES, opts.set ?? "base"));
  store.db.close();
  return { db, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { db: { type: "string" }, set: { type: "string" } } });
  const r = seedDemo({ db: values.db, set: values.set });
  console.log(`Seeded ${r.conversations} conversations / ${r.messages} messages into ${r.db}`);
}
