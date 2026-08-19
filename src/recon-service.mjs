import { createHash } from "node:crypto";
import { appendAudit, withTransaction } from "./database.mjs";
import { matchRecords, MatchingBudgetExceeded } from "./matching.mjs";

export const engineVersion = "foundation-matcher-v1";
const sourceTypes = new Set(["stripe", "paypal", "wise", "bank", "shopify"]);
const amountFields = new Set(["gross_minor", "net_minor"]);

export async function runReconciliation({ pool, tenantId, actorId, requestId, idempotencyKey, periodStart, periodEnd, rule }) {
  const definition = validateRule({ periodStart, periodEnd, rule, idempotencyKey });
  const ruleJson = stableStringify(definition.rule);
  const ruleSha256 = createHash("sha256").update(ruleJson).digest("hex");

  return withTransaction(pool, async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`recon:${tenantId}:${idempotencyKey}`]);
    const existing = await client.query("SELECT id, status, stats, error FROM recon_runs WHERE tenant_id = $1 AND idempotency_key = $2", [tenantId, idempotencyKey]);
    if (existing.rowCount) return { runId: existing.rows[0].id, status: existing.rows[0].status, stats: existing.rows[0].stats, error: existing.rows[0].error, replayed: true };

    const highwaterResult = await client.query("SELECT transaction_timestamp() AS highwater");
    const highwater = highwaterResult.rows[0].highwater;
    const run = await client.query(
      `INSERT INTO recon_runs
        (tenant_id, period_start, period_end, status, rule_definition, rule_sha256, engine_version,
         record_highwater, idempotency_key, created_by)
       VALUES ($1,$2,$3,'running',$4::jsonb,$5,$6,$7,$8,$9) RETURNING id`,
      [tenantId, periodStart, periodEnd, ruleJson, ruleSha256, engineVersion, highwater, idempotencyKey, actorId],
    );
    const runId = run.rows[0].id;
    const records = await loadRecords(client, tenantId, periodStart, periodEnd, highwater, definition.rule);
    let matched;
    try {
      matched = matchRecords({
        sources: records.sources,
        targets: records.targets,
        dateWindowDays: definition.rule.dateWindowDays,
        maxCandidates: definition.rule.maxCandidates,
        maxCombinationSize: definition.rule.maxCombinationSize,
        timeBudgetMs: definition.rule.timeBudgetMs,
        allowPartial: definition.rule.allowPartial,
        identifierPairs: definition.rule.identifierPairs,
      });
    } catch (error) {
      if (!(error instanceof MatchingBudgetExceeded)) throw error;
      const failure = { code: error.code, message: error.message };
      await client.query("UPDATE recon_runs SET status = 'failed', error = $2::jsonb, completed_at = now() WHERE id = $1", [runId, JSON.stringify(failure)]);
      await appendAudit(client, { tenantId, actorId, action: "recon_run.failed", objectType: "recon_run", objectId: runId, requestId, metadata: failure });
      return { runId, status: "failed", error: failure, replayed: false };
    }

    for (const group of matched.groups) {
      const groupResult = await client.query(
        `INSERT INTO match_groups
          (tenant_id, recon_run_id, match_type, currency, amount_minor, source_total_minor, target_total_minor, evidence)
         VALUES ($1,$2,$3,$4,$5,$5,$5,$6::jsonb) RETURNING id`,
        [tenantId, runId, group.type, group.currency, group.amountMinor.toString(), JSON.stringify({ method: group.evidence, ruleSha256, engineVersion })],
      );
      for (const allocation of group.allocations) {
        await client.query(
          `INSERT INTO record_allocations
            (tenant_id, recon_run_id, match_group_id, canonical_record_id, role, currency, allocated_minor, rule_step)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, runId, groupResult.rows[0].id, allocation.recordId, allocation.role, group.currency, allocation.allocatedMinor.toString(), group.type],
        );
      }
    }

    const exceptions = buildExceptions(matched);
    for (const exception of exceptions) {
      await client.query(
        `INSERT INTO recon_exceptions
          (tenant_id, recon_run_id, canonical_record_id, exception_type, severity, amount_minor, currency, details, dedupe_key)
         VALUES ($1,$2,$3,$4,'blocking',$5,$6,$7::jsonb,$8)`,
        [tenantId, runId, exception.recordId, exception.type, exception.amountMinor?.toString() ?? null, exception.currency ?? null, JSON.stringify(exception.details), exception.dedupeKey],
      );
    }
    const stats = serializeStats(matched.stats, exceptions.length);
    await client.query("UPDATE recon_runs SET status = 'completed', stats = $2::jsonb, completed_at = now() WHERE id = $1", [runId, JSON.stringify(stats)]);
    await appendAudit(client, { tenantId, actorId, action: "recon_run.completed", objectType: "recon_run", objectId: runId, requestId, metadata: { ...stats, ruleSha256 } });
    return { runId, status: "completed", stats, replayed: false };
  });
}

async function loadRecords(client, tenantId, periodStart, periodEnd, highwater, rule) {
  const allTypes = [...new Set([...rule.sourceTypes, ...rule.targetTypes])];
  const result = await client.query(
    `SELECT id, source_type, record_type, currency, gross_minor, net_minor, attributes,
            COALESCE(value_date, event_at::date) AS business_date
       FROM canonical_records
      WHERE tenant_id = $1
        AND created_at <= $2
        AND COALESCE(value_date, event_at::date) BETWEEN $3 AND $4
        AND source_type = ANY($5::text[])
      ORDER BY COALESCE(value_date, event_at::date), id`,
    [tenantId, highwater, periodStart, periodEnd, allTypes],
  );
  const sources = [];
  const targets = [];
  for (const row of result.rows) {
    if (rule.sourceTypes.includes(row.source_type) && includesRecordType(rule.sourceRecordTypes, row.record_type)) sources.push(projectRecord(row, rule.sourceAmountField, rule.sourceAbsolute));
    if (rule.targetTypes.includes(row.source_type) && includesRecordType(rule.targetRecordTypes, row.record_type)) targets.push(projectRecord(row, rule.targetAmountField, rule.targetAbsolute));
  }
  return { sources, targets };
}

function projectRecord(row, amountField, absolute) {
  const raw = row[amountField];
  if (raw === null || raw === undefined) throw new Error(`Record ${row.id} has no ${amountField}`);
  const signed = BigInt(raw);
  const amountMinor = absolute && signed < 0n ? -signed : signed;
  if (amountMinor <= 0n) throw new Error(`Record ${row.id} has non-positive match amount`);
  return { id: row.id, sourceType: row.source_type, recordType: row.record_type, currency: row.currency, businessDate: databaseDay(row.business_date), amountMinor, attributes: row.attributes || {} };
}

function buildExceptions(result) {
  const items = [];
  for (const issue of result.issues) items.push({ recordId: issue.recordId, type: issue.type, details: { role: issue.role, candidateIds: issue.candidateIds }, dedupeKey: `issue:${issue.type}:${issue.role}:${issue.recordId}` });
  for (const unmatched of [...result.unmatchedSources, ...result.unmatchedTargets]) {
    items.push({ recordId: unmatched.recordId, type: `unmatched_${unmatched.role}`, amountMinor: unmatched.remainingMinor, currency: unmatched.currency, details: { role: unmatched.role }, dedupeKey: `unmatched:${unmatched.role}:${unmatched.recordId}` });
  }
  return items;
}

function serializeStats(stats, blockingExceptionCount) {
  return {
    sourceCount: stats.sourceCount,
    targetCount: stats.targetCount,
    groupCount: stats.groupCount,
    matchedSourceMinor: stats.matchedSourceMinor.toString(),
    matchedTargetMinor: stats.matchedTargetMinor.toString(),
    blockingExceptionCount,
    elapsedMs: Number(stats.elapsedMs.toFixed(3)),
  };
}

function validateRule({ periodStart, periodEnd, rule, idempotencyKey }) {
  if (!validDay(periodStart) || !validDay(periodEnd) || periodStart > periodEnd) throw codedError("INVALID_PERIOD", "Invalid reconciliation period");
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) throw codedError("INVALID_IDEMPOTENCY_KEY", "Idempotency key must contain 8 to 200 characters");
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw codedError("INVALID_RULE", "Rule is required");
  const normalized = {
    sourceTypes: typeList(rule.sourceTypes, "sourceTypes"),
    targetTypes: typeList(rule.targetTypes, "targetTypes"),
    sourceRecordTypes: optionalStringList(rule.sourceRecordTypes),
    targetRecordTypes: optionalStringList(rule.targetRecordTypes),
    sourceAmountField: amountField(rule.sourceAmountField || "net_minor"),
    targetAmountField: amountField(rule.targetAmountField || "net_minor"),
    sourceAbsolute: rule.sourceAbsolute !== false,
    targetAbsolute: rule.targetAbsolute !== false,
    dateWindowDays: boundedInteger(rule.dateWindowDays, 7, 0, 366, "dateWindowDays"),
    maxCandidates: boundedInteger(rule.maxCandidates, 20, 1, 100, "maxCandidates"),
    maxCombinationSize: boundedInteger(rule.maxCombinationSize, 5, 2, 10, "maxCombinationSize"),
    timeBudgetMs: boundedInteger(rule.timeBudgetMs, 1000, 1, 30_000, "timeBudgetMs"),
    allowPartial: rule.allowPartial === true,
    identifierPairs: validateIdentifierPairs(rule.identifierPairs || []),
  };
  if (normalized.sourceTypes.some((type) => normalized.targetTypes.includes(type))) throw codedError("INVALID_RULE", "Source and target types must not overlap");
  return { periodStart, periodEnd, rule: normalized };
}

function typeList(value, field) {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw codedError("INVALID_RULE", `${field} must be a non-empty array`);
  const unique = [...new Set(value.map(String))];
  if (unique.some((type) => !sourceTypes.has(type))) throw codedError("INVALID_RULE", `${field} contains an unsupported source`);
  return unique.sort();
}

function optionalStringList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || !item.length || item.length > 80)) throw codedError("INVALID_RULE", "Record type filters are invalid");
  return [...new Set(value)].sort();
}

function amountField(value) { if (!amountFields.has(value)) throw codedError("INVALID_RULE", "Amount field is invalid"); return value; }
function boundedInteger(value, fallback, min, max, field) { const result = value === undefined ? fallback : value; if (!Number.isInteger(result) || result < min || result > max) throw codedError("INVALID_RULE", `${field} is out of range`); return result; }
function includesRecordType(filters, value) { return !filters.length || filters.includes(value); }
function validDay(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function validateIdentifierPairs(value) {
  if (!Array.isArray(value) || value.length > 5) throw codedError("INVALID_RULE", "identifierPairs is invalid");
  return value.map((pair) => {
    for (const side of ["source", "target"]) if (typeof pair?.[side] !== "string" || !/^attributes\.[A-Za-z0-9_]{1,80}$/.test(pair[side])) throw codedError("INVALID_RULE", "Identifier paths must reference attributes fields");
    return { source: pair.source, target: pair.target };
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function databaseDay(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }

function codedError(code, message, metadata = {}) { return Object.assign(new Error(message), { code, metadata }); }
