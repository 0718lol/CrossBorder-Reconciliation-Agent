export async function getWorkspaceSnapshot(pool, tenantId, role) {
  const [tenant, counts, currencies] = await Promise.all([
    pool.query("SELECT id, name, status, created_at FROM tenants WHERE id = $1", [tenantId]),
    pool.query(
      `SELECT
         (SELECT count(*)::int FROM data_sources WHERE tenant_id = $1) AS source_count,
         (SELECT count(*)::int FROM import_batches WHERE tenant_id = $1 AND status = 'committed') AS import_count,
         (SELECT count(*)::int FROM canonical_records WHERE tenant_id = $1) AS record_count,
         (SELECT count(*)::int FROM recon_runs WHERE tenant_id = $1 AND status = 'completed') AS run_count,
         (SELECT count(*)::int FROM recon_exceptions WHERE tenant_id = $1 AND status <> 'resolved') AS open_exception_count,
         (SELECT count(*)::int FROM close_periods WHERE tenant_id = $1 AND status = 'locked') AS locked_period_count`,
      [tenantId],
    ),
    pool.query(
      `SELECT currency, count(*)::int AS record_count
         FROM canonical_records WHERE tenant_id = $1
        GROUP BY currency ORDER BY currency`,
      [tenantId],
    ),
  ]);
  return {
    tenant: tenant.rows[0],
    role,
    counts: counts.rows[0],
    currencies: currencies.rows,
  };
}

export async function listSources(pool, tenantId) {
  const result = await pool.query(
    `SELECT ds.id, ds.name, ds.source_type, ds.created_at,
            count(b.id)::int AS import_count,
            COALESCE(sum(b.row_count) FILTER (WHERE b.status = 'committed'), 0)::int AS imported_rows,
            max(b.committed_at) AS last_import_at
       FROM data_sources ds
       LEFT JOIN import_batches b ON b.data_source_id = ds.id AND b.tenant_id = ds.tenant_id
      WHERE ds.tenant_id = $1
      GROUP BY ds.id
      ORDER BY ds.source_type, lower(ds.name)`,
    [tenantId],
  );
  return result.rows;
}

export async function getPeriodArchive(pool, tenantId, periodId) {
  const result = await pool.query(
    `SELECT id, period_start, period_end, version, status, parent_period_id, manifest_sha256,
            snapshot, reopen_reason, created_by, closed_by, created_at, locked_at
       FROM close_periods WHERE tenant_id = $1 AND id = $2`,
    [tenantId, periodId],
  );
  return result.rows[0] || null;
}

export async function getMoneyFlow(pool, tenantId) {
  const [stages, cases] = await Promise.all([
    pool.query(
      `SELECT source_type, record_type, currency, count(*)::int AS record_count,
              COALESCE(sum(gross_minor), 0)::text AS gross_minor,
              COALESCE(sum(fee_minor), 0)::text AS fee_minor,
              COALESCE(sum(net_minor), 0)::text AS net_minor
         FROM canonical_records
        WHERE tenant_id = $1
        GROUP BY source_type, record_type, currency
        ORDER BY currency, source_type, record_type`,
      [tenantId],
    ),
    pool.query(
      `WITH ranked_runs AS (
         SELECT id, row_number() OVER (
           PARTITION BY period_start, period_end, rule_sha256 ORDER BY completed_at DESC, id DESC
         ) AS position
           FROM recon_runs
          WHERE tenant_id = $1 AND status = 'completed'
       )
       SELECT g.id, g.recon_run_id, g.match_type, g.currency, g.amount_minor,
              json_agg(json_build_object(
                'recordId', c.id,
                'role', a.role,
                'allocatedMinor', a.allocated_minor::text,
                'sourceType', c.source_type,
                'recordType', c.record_type,
                'externalId', c.external_id,
                'grossMinor', c.gross_minor::text,
                'feeMinor', c.fee_minor::text,
                'netMinor', c.net_minor::text,
                'businessDate', COALESCE(c.value_date, c.event_at::date)
              ) ORDER BY a.role, c.source_type, c.external_id) AS records
         FROM match_groups g
         JOIN ranked_runs r ON r.id = g.recon_run_id AND r.position = 1
         JOIN record_allocations a ON a.match_group_id = g.id AND a.tenant_id = g.tenant_id
         JOIN canonical_records c ON c.id = a.canonical_record_id AND c.tenant_id = g.tenant_id
        WHERE g.tenant_id = $1
        GROUP BY g.id
        ORDER BY g.created_at DESC, g.id
        LIMIT 20`,
      [tenantId],
    ),
  ]);
  return { stages: stages.rows, cases: cases.rows };
}

export async function listExceptions(pool, tenantId, filters = {}) {
  const params = [tenantId];
  const conditions = ["e.tenant_id = $1"];
  if (filters.status === "active") conditions.push("e.status <> 'resolved'");
  for (const [column, value, allowed] of [
    ["e.status", filters.status === "active" ? null : filters.status, new Set(["open", "investigating", "pending_review", "resolved"])],
    ["e.severity", filters.severity, new Set(["warning", "blocking"])],
    ["e.currency", filters.currency, new Set(["USD", "EUR", "GBP", "HKD"])],
  ]) {
    if (!value) continue;
    if (!allowed.has(value)) throw codedError("INVALID_FILTER");
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  }
  const result = await pool.query(
    `SELECT e.id, e.recon_run_id, e.canonical_record_id, e.exception_type, e.severity,
            e.status, e.amount_minor, e.currency, e.details, e.assignee_id, e.assigned_at,
            e.workflow_version, e.resolved_by, e.resolved_at, e.created_at,
            au.email AS assignee_email, ru.email AS resolved_by_email,
            c.external_id, c.source_type, c.record_type,
            COALESCE(c.value_date, c.event_at::date) AS business_date,
            r.period_start, r.period_end, r.rule_sha256,
            COALESCE(ai.ai_suggestion_count, 0) AS ai_suggestion_count
       FROM recon_exceptions e
       JOIN recon_runs r ON r.id = e.recon_run_id AND r.tenant_id = e.tenant_id
       LEFT JOIN canonical_records c ON c.id = e.canonical_record_id AND c.tenant_id = e.tenant_id
       LEFT JOIN users au ON au.id = e.assignee_id
       LEFT JOIN users ru ON ru.id = e.resolved_by
       LEFT JOIN (
         SELECT object_id, count(*)::int AS ai_suggestion_count
           FROM audit_events
          WHERE tenant_id = $1
            AND object_type = 'recon_exception'
            AND action = 'ai.exception_suggestion_generated'
          GROUP BY object_id
       ) ai ON ai.object_id = e.id::text
      WHERE ${conditions.join(" AND ")}
      ORDER BY CASE e.severity WHEN 'blocking' THEN 0 ELSE 1 END, e.created_at DESC, e.id
      LIMIT 200`,
    params,
  );
  return result.rows;
}

function codedError(code) { return Object.assign(new Error(code), { code }); }
