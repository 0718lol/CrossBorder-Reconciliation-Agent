import { closePeriod, createPeriod, reopenPeriod } from "./close-service.mjs";

const periodStart = "2026-08-01";
const periodEnd = "2026-08-31";

export async function ensureDemoPeriodArchive({ pool, tenantId, actorId, requestId, runId }) {
  const lockClient = await pool.connect();
  const lockKey = `demo-period:${tenantId}:${periodStart}:${periodEnd}`;
  await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
  try {
    const existing = await pool.query(
      `SELECT id, version, status FROM close_periods
        WHERE tenant_id = $1 AND period_start = $2 AND period_end = $3
        ORDER BY version DESC`,
      [tenantId, periodStart, periodEnd],
    );
    let locked = existing.rows.find((period) => period.status === "locked");
    let open = existing.rows.find((period) => period.status === "open");

    if (!locked) {
      if (!open) {
        const created = await createPeriod({ pool, tenantId, actorId, requestId, periodStart, periodEnd });
        open = { id: created.periodId, version: created.version, status: created.status };
      }
      const result = await closePeriod({ pool, tenantId, periodId: open.id, runIds: [runId], actorId, requestId });
      locked = { id: result.periodId, version: result.version, status: result.status, manifestSha256: result.manifestSha256 };
      open = null;
    }

    if (!open) {
      const reopened = await reopenPeriod({
        pool,
        tenantId,
        periodId: locked.id,
        actorId,
        requestId: `${requestId}-reopen`,
        reason: "Fictional demo keeps a current version open after the archived close snapshot",
      });
      open = { id: reopened.periodId, version: reopened.version, status: reopened.status };
    }

    return { locked, open };
  } finally {
    try { await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]); }
    finally { lockClient.release(); }
  }
}
