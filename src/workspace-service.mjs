export async function getWorkspaceSnapshot(pool, tenantId, role) {
  const [tenant, counts, currencies] = await Promise.all([
    pool.query("SELECT id, name, status, created_at FROM tenants WHERE id = $1", [tenantId]),
    pool.query(
      `SELECT
         (SELECT count(*)::int FROM data_sources WHERE tenant_id = $1) AS source_count,
         (SELECT count(*)::int FROM import_batches WHERE tenant_id = $1 AND status = 'committed') AS import_count,
         (SELECT count(*)::int FROM canonical_records WHERE tenant_id = $1) AS record_count,
         (SELECT count(*)::int FROM recon_runs WHERE tenant_id = $1 AND status = 'completed') AS run_count,
         (SELECT count(*)::int FROM recon_exceptions WHERE tenant_id = $1 AND status = 'open') AS open_exception_count,
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

export async function listExceptions(pool, tenantId, filters = {}) {
  const params = [tenantId];
  const conditions = ["e.tenant_id = $1"];
  for (const [column, value, allowed] of [
    ["e.status", filters.status, new Set(["open", "resolved"])],
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
            e.status, e.amount_minor, e.currency, e.details, e.created_at,
            c.external_id, c.source_type, c.record_type,
            COALESCE(c.value_date, c.event_at::date) AS business_date,
            r.period_start, r.period_end, r.rule_sha256
       FROM recon_exceptions e
       JOIN recon_runs r ON r.id = e.recon_run_id AND r.tenant_id = e.tenant_id
       LEFT JOIN canonical_records c ON c.id = e.canonical_record_id AND c.tenant_id = e.tenant_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY CASE e.severity WHEN 'blocking' THEN 0 ELSE 1 END, e.created_at DESC, e.id
      LIMIT 200`,
    params,
  );
  return result.rows;
}

function codedError(code) { return Object.assign(new Error(code), { code }); }
