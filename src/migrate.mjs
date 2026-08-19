import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabase } from "./database.mjs";
import { loadConfig } from "./config.mjs";

const config = loadConfig();
const pool = createDatabase(config.databaseUrl);
try {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrationsDir = join(import.meta.dirname, "..", "migrations");
  const names = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [name]);
    if (applied.rowCount) continue;
    const sql = await readFile(join(migrationsDir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
} finally { await pool.end(); }
