import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";

const { Client } = pg;
const requestedUrl = new URL(process.env.DATABASE_URL || "postgres://hyperrecon:hyperrecon_dev_only@127.0.0.1:55432/hyperrecon");
if (!new Set(["127.0.0.1", "localhost", "::1"]).has(requestedUrl.hostname)) {
  throw new Error("Database tests only create temporary databases on localhost");
}
const maintenanceUrl = new URL(requestedUrl);
maintenanceUrl.pathname = "/postgres";
const databaseName = `hyperrecon_test_${randomBytes(8).toString("hex")}`;
const testUrl = new URL(requestedUrl);
testUrl.pathname = `/${databaseName}`;
const client = new Client({ connectionString: maintenanceUrl.toString() });
const testFiles = process.argv.slice(2);
if (!testFiles.length) throw new Error("At least one test file is required");

let exitCode = 1;
await client.connect();
try {
  await client.query(`CREATE DATABASE ${databaseName}`);
  await run([new URL("../src/migrate.mjs", import.meta.url).pathname], { DATABASE_URL: testUrl.toString() });
  exitCode = await run(["--test", ...testFiles], { DATABASE_URL: testUrl.toString(), RUN_DATABASE_TESTS: "1" }, false);
} finally {
  await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName]);
  await client.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await client.end();
}
process.exitCode = exitCode;

function run(args, extraEnv, rejectOnFailure = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: new URL("..", import.meta.url), env: { ...process.env, ...extraEnv }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const result = code ?? (signal ? 1 : 0);
      if (rejectOnFailure && result !== 0) reject(new Error(`Child process failed with exit code ${result}`));
      else resolve(result);
    });
  });
}
