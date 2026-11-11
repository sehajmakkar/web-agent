import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DB = Database.Database;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Open (creating if needed) the SQLite database and apply pending migrations.
 * Migrations are numbered .sql files; progress is tracked in PRAGMA user_version.
 * Pass ":memory:" for tests.
 */
export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}
