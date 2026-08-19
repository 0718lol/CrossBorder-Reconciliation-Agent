import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { authenticateSession, authorizeRequest, createDatabase } from "../src/database.mjs";
import { hashPassword, hashSessionToken } from "../src/auth.mjs";
import { importCsv } from "../src/import-service.mjs";
import { preflightCsv } from "../src/csv.mjs";
import { createSessionForCredentials } from "../src/session-service.mjs";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
const databaseUrl = process.env.DATABASE_URL || "postgres://hyperrecon:hyperrecon_dev_only@127.0.0.1:55432/hyperrecon";
const pool = enabled ? createDatabase(databaseUrl) : null;
let objectStorageDir;

before(async () => {
  if (enabled) objectStorageDir = await mkdtemp(join(tmpdir(), "hyperrecon-objects-"));
});

after(async () => {
  if (pool) await pool.end();
  if (objectStorageDir) await rm(objectStorageDir, { recursive: true, force: true });
});

test("database import is atomic, idempotent, tenant-scoped, and audited", { skip: !enabled }, async () => {
  const suffix = randomUUID();
  const passwordHash = await hashPassword("integration-test-password");
  const tenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Integration ${suffix}`]);
  const otherTenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Other ${suffix}`]);
  const user = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [`integration-${suffix}@example.test`, passwordHash]);
  const tenantId = tenant.rows[0].id;
  const userId = user.rows[0].id;
  await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,'admin')", [tenantId, userId]);
  const stripeSource = await pool.query("INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1,'stripe-test','stripe') RETURNING id", [tenantId]);
  const paypalSource = await pool.query("INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1,'paypal-test','paypal') RETURNING id", [tenantId]);
  const raceSource = await pool.query("INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1,'stripe-race','stripe') RETURNING id", [tenantId]);

  const stripeBuffer = await fixture("stripe_balance_transactions.csv");
  const first = await importCsv({ pool, objectStorageDir, tenantId, dataSourceId: stripeSource.rows[0].id, sourceType: "stripe", filename: "stripe.csv", buffer: stripeBuffer, actorId: userId, requestId: suffix });
  assert.equal(first.status, "committed");
  assert.equal(first.replayed, false);
  assert.equal(first.preflight.rowCount, 4);

  const stored = await pool.query(
    `SELECT b.status, b.row_count, count(DISTINCT r.id)::int AS raw_count, count(DISTINCT c.id)::int AS canonical_count
       FROM import_batches b
       JOIN raw_rows r ON r.import_batch_id = b.id
       JOIN canonical_records c ON c.import_batch_id = b.id
      WHERE b.id = $1 GROUP BY b.id`,
    [first.batchId],
  );
  assert.deepEqual(stored.rows[0], { status: "committed", row_count: 4, raw_count: 4, canonical_count: 4 });
  await stat(join(objectStorageDir, tenantId, first.preflight.sha256.slice(0, 2), `${first.preflight.sha256}.csv`));

  const replay = await importCsv({ pool, objectStorageDir, tenantId, dataSourceId: stripeSource.rows[0].id, sourceType: "stripe", filename: "renamed.csv", buffer: stripeBuffer, actorId: userId, requestId: `${suffix}-replay` });
  assert.equal(replay.replayed, true);
  assert.equal(replay.batchId, first.batchId);
  const uniqueBatch = await pool.query("SELECT count(*)::int AS count FROM import_batches WHERE tenant_id = $1 AND data_source_id = $2", [tenantId, stripeSource.rows[0].id]);
  assert.equal(uniqueBatch.rows[0].count, 1);

  const concurrent = await Promise.all([
    importCsv({ pool, objectStorageDir, tenantId, dataSourceId: raceSource.rows[0].id, sourceType: "stripe", filename: "race-a.csv", buffer: stripeBuffer, actorId: userId, requestId: `${suffix}-race-a` }),
    importCsv({ pool, objectStorageDir, tenantId, dataSourceId: raceSource.rows[0].id, sourceType: "stripe", filename: "race-b.csv", buffer: stripeBuffer, actorId: userId, requestId: `${suffix}-race-b` }),
  ]);
  assert.equal(concurrent[0].batchId, concurrent[1].batchId);
  assert.deepEqual(concurrent.map((item) => item.replayed).sort(), [false, true]);
  const concurrentCount = await pool.query("SELECT count(*)::int AS count FROM import_batches WHERE tenant_id = $1 AND data_source_id = $2", [tenantId, raceSource.rows[0].id]);
  assert.equal(concurrentCount.rows[0].count, 1);

  const paypalBuffer = await fixture("paypal_transactions.csv");
  const failedPreflight = preflightCsv(paypalBuffer, { sourceType: "paypal" });
  await assert.rejects(
    importCsv({ pool, objectStorageDir, tenantId, dataSourceId: paypalSource.rows[0].id, sourceType: "paypal", filename: "paypal.csv", buffer: paypalBuffer, actorId: userId, requestId: `${suffix}-fault`, faultAfterRows: 1 }),
    /Injected import failure/,
  );
  const failedCounts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM import_batches WHERE tenant_id = $1 AND data_source_id = $2) AS batches,
       (SELECT count(*)::int FROM raw_rows r JOIN import_batches b ON b.id = r.import_batch_id
         WHERE b.tenant_id = $1 AND b.data_source_id = $2) AS stray_raw,
       (SELECT count(*)::int FROM canonical_records c JOIN import_batches b ON b.id = c.import_batch_id
         WHERE b.tenant_id = $1 AND b.data_source_id = $2) AS stray_canonical`,
    [tenantId, paypalSource.rows[0].id],
  );
  assert.deepEqual(failedCounts.rows[0], { batches: 0, stray_raw: 0, stray_canonical: 0 });
  await assert.rejects(stat(join(objectStorageDir, tenantId, failedPreflight.sha256.slice(0, 2), `${failedPreflight.sha256}.csv`)), { code: "ENOENT" });

  const audit = await pool.query("SELECT id FROM audit_events WHERE tenant_id = $1 AND action = 'import_batch.committed'", [tenantId]);
  assert.equal(audit.rowCount, 2);
  await assert.rejects(pool.query("UPDATE audit_events SET action = 'tampered' WHERE id = $1", [audit.rows[0].id]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM audit_events WHERE id = $1", [audit.rows[0].id]), /append-only/);

  const tokenHash = hashSessionToken(`integration-${suffix}`);
  await pool.query("INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,now() + interval '1 hour')", [userId, tokenHash]);
  assert.equal(await authenticateSession(pool, tokenHash), userId);
  assert.deepEqual(await authorizeRequest(pool, tokenHash, tenantId, ["admin"]), { userId, role: "admin", tenantId });
  assert.equal(await authorizeRequest(pool, tokenHash, otherTenant.rows[0].id, ["admin"]), null);
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [tokenHash]);
  assert.equal(await authenticateSession(pool, tokenHash), null);
});

function fixture(name) {
  return readFile(join(import.meta.dirname, "..", "fixtures", name));
}

test("login selects one workspace and requires a choice for multiple memberships", { skip: !enabled }, async () => {
  const suffix = randomUUID();
  const password = "workspace-login-test-password";
  const passwordHash = await hashPassword(password);
  const dummyPasswordHash = await hashPassword("workspace-login-dummy-password");
  const user = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [`workspace-${suffix}@example.test`, passwordHash]);
  const first = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Workspace A ${suffix}`]);
  const second = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Workspace B ${suffix}`]);
  await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,'operator')", [first.rows[0].id, user.rows[0].id]);

  const single = await createSessionForCredentials({
    pool, email: `WORKSPACE-${suffix}@EXAMPLE.TEST`, password, dummyPasswordHash,
    sessionTtlSeconds: 3600, requestId: suffix,
  });
  assert.equal(single.tenantId, first.rows[0].id);
  assert.equal(single.role, "operator");
  await assert.rejects(
    createSessionForCredentials({
      pool, email: `workspace-${suffix}@example.test`, password: "wrong-password",
      dummyPasswordHash, sessionTtlSeconds: 3600, requestId: suffix,
    }),
    (error) => error.code === "INVALID_CREDENTIALS",
  );

  await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,'reviewer')", [second.rows[0].id, user.rows[0].id]);
  await assert.rejects(
    createSessionForCredentials({
      pool, email: `workspace-${suffix}@example.test`, password,
      dummyPasswordHash, sessionTtlSeconds: 3600, requestId: suffix,
    }),
    (error) => error.code === "WORKSPACE_REQUIRED" && error.metadata.workspaces.length === 2,
  );
  const selected = await createSessionForCredentials({
    pool, email: `workspace-${suffix}@example.test`, password, tenantId: second.rows[0].id,
    dummyPasswordHash, sessionTtlSeconds: 3600, requestId: suffix,
  });
  assert.equal(selected.tenantId, second.rows[0].id);
  assert.equal(selected.role, "reviewer");
});
