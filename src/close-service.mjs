import { createHash } from "node:crypto";
import { appendAudit, withTransaction } from "./database.mjs";

export async function createPeriod({ pool, tenantId, actorId, requestId, periodStart, periodEnd }) {
  validatePeriod(periodStart, periodEnd);
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`period:${tenantId}:${periodStart}:${periodEnd}`]);
    const existing = await client.query(
      "SELECT id, version, status FROM close_periods WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3 AND status = 'open'",
      [tenantId, periodStart, periodEnd],
    );
    if (existing.rowCount) return { periodId: existing.rows[0].id, version: existing.rows[0].version, status: "open", replayed: true };
    const next = await client.query(
      "SELECT COALESCE(max(version), 0) + 1 AS version FROM close_periods WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3",
      [tenantId, periodStart, periodEnd],
    );
    const created = await client.query(
      `INSERT INTO close_periods (tenant_id, period_start, period_end, version, status, created_by)
       VALUES ($1,$2,$3,$4,'open',$5) RETURNING id, version`,
      [tenantId, periodStart, periodEnd, next.rows[0].version, actorId],
    );
    await appendAudit(client, { tenantId, actorId, action: "close_period.created", objectType: "close_period", objectId: created.rows[0].id, requestId, metadata: { periodStart, periodEnd, version: created.rows[0].version } });
    return { periodId: created.rows[0].id, version: created.rows[0].version, status: "open", replayed: false };
  });
}

export async function closePeriod({ pool, tenantId, periodId, runIds, actorId, requestId }) {
  const uniqueRunIds = validateRunIds(runIds);
  return withTransaction(pool, async (client) => {
    const periodResult = await client.query("SELECT * FROM close_periods WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [periodId, tenantId]);
    if (!periodResult.rowCount) throw codedError("PERIOD_NOT_FOUND", "Close period was not found");
    const period = periodResult.rows[0];
    if (period.status === "locked") return { periodId, version: period.version, status: "locked", manifestSha256: period.manifest_sha256, snapshot: period.snapshot, replayed: true };

    const runsResult = await client.query(
      `SELECT id, status, period_start, period_end, rule_sha256, engine_version, record_highwater, stats, completed_at
         FROM recon_runs WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id`,
      [tenantId, uniqueRunIds],
    );
    if (runsResult.rowCount !== uniqueRunIds.length) throw codedError("INVALID_RUN_SET", "One or more reconciliation runs are missing");
    if (runsResult.rows.some((run) => run.status !== "completed" || day(run.period_start) !== day(period.period_start) || day(run.period_end) !== day(period.period_end))) throw codedError("INVALID_RUN_SET", "Runs must be completed for the same period");
    const duplicateAllocations = await client.query(
      `SELECT canonical_record_id FROM record_allocations
        WHERE recon_run_id = ANY($1::uuid[])
        GROUP BY canonical_record_id HAVING count(DISTINCT recon_run_id) > 1 LIMIT 1`,
      [uniqueRunIds],
    );
    if (duplicateAllocations.rowCount) throw codedError("INVALID_RUN_SET", "Selected runs allocate the same canonical record more than once");
    const blocking = await client.query(
      `SELECT count(*)::int AS count FROM recon_exceptions
        WHERE recon_run_id = ANY($1::uuid[]) AND status = 'open' AND severity = 'blocking'`,
      [uniqueRunIds],
    );
    if (blocking.rows[0].count > 0) throw codedError("CLOSE_BLOCKED", "Blocking reconciliation exceptions remain open", { blockingExceptionCount: blocking.rows[0].count });

    for (const runId of uniqueRunIds) await client.query("INSERT INTO close_period_runs (close_period_id, recon_run_id) VALUES ($1,$2)", [periodId, runId]);
    const snapshot = await buildSnapshot(client, period, runsResult.rows, uniqueRunIds);
    const manifestSha256 = createHash("sha256").update(stableStringify(snapshot)).digest("hex");
    await client.query(
      `UPDATE close_periods SET status = 'locked', snapshot = $2::jsonb, manifest_sha256 = $3,
         closed_by = $4, locked_at = now() WHERE id = $1`,
      [periodId, JSON.stringify(snapshot), manifestSha256, actorId],
    );
    await appendAudit(client, { tenantId, actorId, action: "close_period.locked", objectType: "close_period", objectId: periodId, requestId, metadata: { version: period.version, manifestSha256, runIds: uniqueRunIds } });
    return { periodId, version: period.version, status: "locked", manifestSha256, snapshot, replayed: false };
  });
}

export async function reopenPeriod({ pool, tenantId, periodId, actorId, requestId, reason }) {
  const normalizedReason = String(reason || "").trim();
  if (normalizedReason.length < 10 || normalizedReason.length > 1000) throw codedError("INVALID_REASON", "Reopen reason must contain 10 to 1000 characters");
  return withTransaction(pool, async (client) => {
    const periodResult = await client.query("SELECT * FROM close_periods WHERE id = $1 AND tenant_id = $2 FOR UPDATE", [periodId, tenantId]);
    if (!periodResult.rowCount) throw codedError("PERIOD_NOT_FOUND", "Close period was not found");
    const period = periodResult.rows[0];
    if (period.status !== "locked") throw codedError("INVALID_PERIOD_STATE", "Only a locked period can be reopened");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`period:${tenantId}:${day(period.period_start)}:${day(period.period_end)}`]);
    const existing = await client.query(
      "SELECT id, version FROM close_periods WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3 AND status = 'open'",
      [tenantId, period.period_start, period.period_end],
    );
    if (existing.rowCount) return { periodId: existing.rows[0].id, version: existing.rows[0].version, status: "open", replayed: true };
    const created = await client.query(
      `INSERT INTO close_periods
        (tenant_id, period_start, period_end, version, status, parent_period_id, reopen_reason, created_by)
       VALUES ($1,$2,$3,$4,'open',$5,$6,$7) RETURNING id, version`,
      [tenantId, period.period_start, period.period_end, period.version + 1, periodId, normalizedReason, actorId],
    );
    await appendAudit(client, { tenantId, actorId, action: "close_period.reopened", objectType: "close_period", objectId: created.rows[0].id, requestId, reason: normalizedReason, metadata: { parentPeriodId: periodId, version: created.rows[0].version } });
    return { periodId: created.rows[0].id, version: created.rows[0].version, status: "open", parentPeriodId: periodId, replayed: false };
  });
}

export async function assertPeriodWritable(pool, tenantId, businessDates) {
  const dates = [...new Set(businessDates.filter(Boolean))];
  if (!dates.length) return;
  const result = await pool.query(
    `SELECT DISTINCT p.id, p.period_start, p.period_end, p.version
       FROM close_periods p
      WHERE p.tenant_id = $1 AND p.status = 'locked'
        AND EXISTS (SELECT 1 FROM unnest($2::date[]) AS d(value) WHERE d.value BETWEEN p.period_start AND p.period_end)
        AND NOT EXISTS (
          SELECT 1 FROM close_periods newer
           WHERE newer.tenant_id = p.tenant_id
             AND newer.period_start = p.period_start AND newer.period_end = p.period_end
             AND newer.version > p.version AND newer.status = 'open'
        )
      LIMIT 1`,
    [tenantId, dates],
  );
  if (result.rowCount) throw codedError("PERIOD_LOCKED", "An imported record belongs to a locked period", { periodId: result.rows[0].id, version: result.rows[0].version });
}

async function buildSnapshot(client, period, runs, runIds) {
  const files = await client.query(
    `SELECT DISTINCT b.id, b.sha256, b.parser_version, b.template_version, b.row_count
       FROM import_batches b
       JOIN canonical_records c ON c.import_batch_id = b.id
       JOIN record_allocations a ON a.canonical_record_id = c.id
      WHERE a.recon_run_id = ANY($1::uuid[])
      ORDER BY b.id`,
    [runIds],
  );
  const totals = await client.query(
    `SELECT currency, role, sum(allocated_minor)::text AS allocated_minor
       FROM record_allocations WHERE recon_run_id = ANY($1::uuid[])
      GROUP BY currency, role ORDER BY currency, role`,
    [runIds],
  );
  const audit = await client.query("SELECT COALESCE(max(id), 0)::text AS highwater FROM audit_events WHERE tenant_id = $1", [period.tenant_id]);
  return {
    schemaVersion: "foundation-close-manifest-v1",
    tenantId: period.tenant_id,
    periodId: period.id,
    periodStart: day(period.period_start),
    periodEnd: day(period.period_end),
    version: period.version,
    runs: runs.map((run) => ({ id: run.id, ruleSha256: run.rule_sha256, engineVersion: run.engine_version, recordHighwater: new Date(run.record_highwater).toISOString(), stats: run.stats, completedAt: new Date(run.completed_at).toISOString() })),
    files: files.rows.map((file) => ({ id: file.id, sha256: file.sha256, parserVersion: file.parser_version, templateVersion: file.template_version, rowCount: file.row_count })),
    allocationTotals: totals.rows.map((total) => ({ currency: total.currency, role: total.role, allocatedMinor: total.allocated_minor })),
    auditHighwater: audit.rows[0].highwater,
  };
}

function validatePeriod(start, end) { if (!validDay(start) || !validDay(end) || start > end) throw codedError("INVALID_PERIOD", "Invalid close period"); }
function validateRunIds(value) { if (!Array.isArray(value) || !value.length || value.length > 20 || value.some((id) => !/^[0-9a-f-]{36}$/i.test(String(id)))) throw codedError("INVALID_RUN_SET", "runIds must contain 1 to 20 UUIDs"); return [...new Set(value.map(String))].sort(); }
function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function day(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function codedError(code, message, metadata = {}) { return Object.assign(new Error(message), { code, metadata }); }
