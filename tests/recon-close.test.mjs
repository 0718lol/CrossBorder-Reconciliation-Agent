import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.mjs";
import { hashPassword } from "../src/auth.mjs";
import { importCsv } from "../src/import-service.mjs";
import { runReconciliation } from "../src/recon-service.mjs";
import { closePeriod, createPeriod, reopenPeriod } from "../src/close-service.mjs";
import { getMoneyFlow, getPeriodArchive } from "../src/workspace-service.mjs";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
const databaseUrl = process.env.DATABASE_URL || "postgres://hyperrecon:hyperrecon_dev_only@127.0.0.1:55432/hyperrecon";
const pool = enabled ? createDatabase(databaseUrl) : null;
let objectStorageDir;

before(async () => {
  if (enabled) objectStorageDir = await mkdtemp(join(tmpdir(), "hyperrecon-close-"));
});

after(async () => {
  if (pool) await pool.end();
  if (objectStorageDir) await rm(objectStorageDir, { recursive: true, force: true });
});

test("reconciliation run and close lifecycle preserve financial invariants", { skip: !enabled }, async () => {
  const suffix = randomUUID();
  const setup = await createTenant(suffix);
  await importFixture(setup, "shopify", "shopify_orders.csv");
  await importFixture(setup, "stripe", "stripe_balance_transactions.csv");
  await importFixture(setup, "paypal", "paypal_transactions.csv");

  const rule = {
    sourceTypes: ["shopify"],
    targetTypes: ["stripe", "paypal"],
    sourceRecordTypes: ["order_paid", "order_partially_refunded"],
    targetRecordTypes: ["charge", "payment"],
    sourceAmountField: "gross_minor",
    targetAmountField: "gross_minor",
    dateWindowDays: 7,
    maxCandidates: 10,
    maxCombinationSize: 5,
  };
  const run = await runReconciliation({ pool, tenantId: setup.tenantId, actorId: setup.userId, requestId: suffix, idempotencyKey: `order-run-${suffix}`, periodStart: "2026-08-01", periodEnd: "2026-08-31", rule });
  assert.equal(run.status, "completed");
  assert.equal(run.stats.groupCount, 2);
  assert.equal(run.stats.blockingExceptionCount, 0);
  assert.equal(run.stats.matchedSourceMinor, "2084080");
  assert.equal(run.stats.matchedTargetMinor, "2084080");

  const moneyFlow = await getMoneyFlow(pool, setup.tenantId);
  assert.equal(moneyFlow.stages.some((stage) => stage.source_type === "shopify" && stage.currency === "USD"), true);
  assert.equal(moneyFlow.cases.length, 2);
  assert.equal(moneyFlow.cases.every((item) => item.records.length >= 2), true);
  assert.equal(
    moneyFlow.cases.every((item) =>
      item.records.every((record) =>
        [record.allocatedMinor, record.grossMinor, record.feeMinor, record.netMinor]
          .filter((value) => value !== null)
          .every((value) => typeof value === "string")
      )
    ),
    true,
    "money-flow evidence must keep bigint amounts as exact decimal strings"
  );
  const isolatedTenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Money Flow Isolation ${suffix}`]);
  assert.deepEqual(await getMoneyFlow(pool, isolatedTenant.rows[0].id), { stages: [], cases: [] });

  const replay = await runReconciliation({ pool, tenantId: setup.tenantId, actorId: setup.userId, requestId: `${suffix}-replay`, idempotencyKey: `order-run-${suffix}`, periodStart: "2026-08-01", periodEnd: "2026-08-31", rule });
  assert.equal(replay.replayed, true);
  assert.equal(replay.runId, run.runId);

  const facts = await pool.query(
    `SELECT count(DISTINCT g.id)::int AS groups,
            sum(CASE WHEN a.role = 'source' THEN a.allocated_minor ELSE 0 END)::text AS source_total,
            sum(CASE WHEN a.role = 'target' THEN a.allocated_minor ELSE 0 END)::text AS target_total
       FROM match_groups g JOIN record_allocations a ON a.match_group_id = g.id
      WHERE g.recon_run_id = $1`,
    [run.runId],
  );
  assert.deepEqual(facts.rows[0], { groups: 2, source_total: "2084080", target_total: "2084080" });
  const group = await pool.query("SELECT id FROM match_groups WHERE recon_run_id = $1 LIMIT 1", [run.runId]);
  await assert.rejects(pool.query("UPDATE match_groups SET amount_minor = amount_minor + 1 WHERE id = $1", [group.rows[0].id]), /immutable/);

  const period = await createPeriod({ pool, tenantId: setup.tenantId, actorId: setup.userId, requestId: suffix, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(period.version, 1);
  assert.equal(period.status, "open");
  const periodReplay = await createPeriod({ pool, tenantId: setup.tenantId, actorId: setup.userId, requestId: `${suffix}-period-replay`, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  assert.equal(periodReplay.periodId, period.periodId);
  assert.equal(periodReplay.replayed, true);

  const overlappingRun = await runReconciliation({ pool, tenantId: setup.tenantId, actorId: setup.userId, requestId: `${suffix}-overlap`, idempotencyKey: `overlap-${suffix}`, periodStart: "2026-08-01", periodEnd: "2026-08-31", rule });
  await assert.rejects(
    closePeriod({ pool, tenantId: setup.tenantId, periodId: period.periodId, runIds: [run.runId, overlappingRun.runId], actorId: setup.userId, requestId: `${suffix}-overlap-close` }),
    (error) => error.code === "INVALID_RUN_SET",
  );

  const closed = await closePeriod({ pool, tenantId: setup.tenantId, periodId: period.periodId, runIds: [run.runId], actorId: setup.userId, requestId: suffix });
  assert.equal(closed.status, "locked");
  assert.match(closed.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(closed.snapshot.runs.length, 1);
  assert.equal(closed.snapshot.files.length, 3);
  const archive = await getPeriodArchive(pool, setup.tenantId, period.periodId);
  assert.equal(archive.status, "locked");
  assert.equal(archive.manifest_sha256, closed.manifestSha256);
  assert.deepEqual(archive.snapshot, closed.snapshot);
  assert.equal(await getPeriodArchive(pool, isolatedTenant.rows[0].id, period.periodId), null);
  const closeReplay = await closePeriod({ pool, tenantId: setup.tenantId, periodId: period.periodId, runIds: [run.runId], actorId: setup.userId, requestId: `${suffix}-close-replay` });
  assert.equal(closeReplay.replayed, true);
  assert.equal(closeReplay.manifestSha256, closed.manifestSha256);
  await assert.rejects(pool.query("UPDATE close_periods SET manifest_sha256 = repeat('0', 64) WHERE id = $1", [period.periodId]), /immutable/);

  const changedShopify = Buffer.from((await fixture("shopify_orders.csv")).toString("utf8").replace("SHOP-TEST-001", `SHOP-LOCKED-${suffix}`));
  await assert.rejects(importCsv({ pool, objectStorageDir, tenantId: setup.tenantId, dataSourceId: setup.sources.shopify, sourceType: "shopify", filename: "locked.csv", buffer: changedShopify, actorId: setup.userId, requestId: `${suffix}-locked` }), (error) => error.code === "PERIOD_LOCKED");

  const reopened = await reopenPeriod({ pool, tenantId: setup.tenantId, periodId: period.periodId, actorId: setup.userId, requestId: `${suffix}-reopen`, reason: "Late provider correction requires a new period version" });
  assert.equal(reopened.version, 2);
  assert.equal(reopened.parentPeriodId, period.periodId);
  const postReopenImport = await importCsv({ pool, objectStorageDir, tenantId: setup.tenantId, dataSourceId: setup.sources.shopify, sourceType: "shopify", filename: "reopened.csv", buffer: changedShopify, actorId: setup.userId, requestId: `${suffix}-reopened` });
  assert.equal(postReopenImport.status, "committed");

  const blockingRun = await runReconciliation({
    pool, tenantId: setup.tenantId, actorId: setup.userId, requestId: `${suffix}-blocking`, idempotencyKey: `blocking-${suffix}`,
    periodStart: "2026-08-01", periodEnd: "2026-08-31",
    rule: { sourceTypes: ["shopify"], targetTypes: ["bank"], sourceAmountField: "gross_minor", targetAmountField: "net_minor" },
  });
  assert.equal(blockingRun.stats.blockingExceptionCount > 0, true);
  await assert.rejects(closePeriod({ pool, tenantId: setup.tenantId, periodId: reopened.periodId, runIds: [blockingRun.runId], actorId: setup.userId, requestId: `${suffix}-blocked-close` }), (error) => error.code === "CLOSE_BLOCKED");
});

async function createTenant(suffix) {
  const passwordHash = await hashPassword("recon-close-test-password");
  const tenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Recon Close ${suffix}`]);
  const user = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [`recon-close-${suffix}@example.test`, passwordHash]);
  const tenantId = tenant.rows[0].id;
  const userId = user.rows[0].id;
  await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,'admin')", [tenantId, userId]);
  const sources = {};
  for (const type of ["shopify", "stripe", "paypal", "bank"]) {
    const result = await pool.query("INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1,$2,$3) RETURNING id", [tenantId, `${type}-${suffix}`, type]);
    sources[type] = result.rows[0].id;
  }
  return { tenantId, userId, sources, suffix };
}

async function importFixture(setup, sourceType, filename) {
  return importCsv({ pool, objectStorageDir, tenantId: setup.tenantId, dataSourceId: setup.sources[sourceType], sourceType, filename, buffer: await fixture(filename), actorId: setup.userId, requestId: `${setup.suffix}-${sourceType}` });
}

function fixture(name) { return readFile(join(import.meta.dirname, "..", "fixtures", name)); }
