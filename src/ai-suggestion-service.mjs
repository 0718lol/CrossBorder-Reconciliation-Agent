import { createHash } from "node:crypto";
import { appendAudit, withTransaction } from "./database.mjs";

const allowedRoles = new Set(["operator", "reviewer"]);
const confidenceLevels = new Set(["low", "medium", "high"]);

export async function generateExceptionSuggestion({ pool, aiClient, tenantId, exceptionId, actorId, requestId }) {
  if (!aiClient) throw codedError("AI_NOT_CONFIGURED");
  const evidence = await loadMinimizedEvidence(pool, tenantId, exceptionId, actorId);
  const response = await aiClient.complete({
    messages: buildMessages(evidence),
    maxTokens: 700,
    responseFormat: "json_object",
  });
  const suggestion = parseSuggestion(response.content);
  const inputEvidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

  return withTransaction(pool, async (client) => {
    const current = await client.query(
      "SELECT workflow_version FROM recon_exceptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, exceptionId],
    );
    if (!current.rowCount) throw codedError("EXCEPTION_NOT_FOUND");
    if (current.rows[0].workflow_version !== evidence.workflowVersion) {
      throw codedError("STALE_EXCEPTION", { currentVersion: current.rows[0].workflow_version });
    }
    const audit = await appendAudit(client, {
      tenantId,
      actorId,
      action: "ai.exception_suggestion_generated",
      objectType: "recon_exception",
      objectId: exceptionId,
      requestId,
      metadata: {
        schemaVersion: 1,
        provider: response.provider,
        model: response.model,
        workflowVersion: evidence.workflowVersion,
        inputEvidenceHash,
        suggestion,
        usage: response.usage,
        providerRequestId: response.providerRequestId,
      },
    });
    return { auditId: audit.id, createdAt: audit.created_at, provider: response.provider, model: response.model, workflowVersion: evidence.workflowVersion, suggestion };
  });
}

export function parseSuggestion(content) {
  let value;
  try { value = JSON.parse(content); }
  catch { throw codedError("AI_PROVIDER_INVALID_RESPONSE"); }
  if (!isPlainObject(value)) throw codedError("AI_PROVIDER_INVALID_RESPONSE");
  const suggestion = {
    likelyCause: boundedText(value.likelyCause, 2, 300),
    confidence: confidenceLevels.has(value.confidence) ? value.confidence : null,
    evidence: boundedTextArray(value.evidence, 1, 5, 300),
    missingEvidence: boundedTextArray(value.missingEvidence, 1, 5, 300),
    nextSteps: boundedTextArray(value.nextSteps, 1, 5, 300),
    cautions: boundedTextArray(value.cautions, 1, 5, 300),
  };
  if (Object.values(suggestion).some((item) => item === null)) throw codedError("AI_PROVIDER_INVALID_RESPONSE");
  return suggestion;
}

async function loadMinimizedEvidence(pool, tenantId, exceptionId, actorId) {
  const [exception, member] = await Promise.all([
    pool.query(
      `SELECT e.exception_type, e.severity, e.status, e.details, e.workflow_version,
              c.source_type, c.record_type
         FROM recon_exceptions e
         LEFT JOIN canonical_records c ON c.id = e.canonical_record_id AND c.tenant_id = e.tenant_id
        WHERE e.tenant_id = $1 AND e.id = $2`,
      [tenantId, exceptionId],
    ),
    pool.query("SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2", [tenantId, actorId]),
  ]);
  if (!exception.rowCount) throw codedError("EXCEPTION_NOT_FOUND");
  if (!allowedRoles.has(member.rows[0]?.role)) throw codedError("INVALID_WORKFLOW_ACTOR");
  if (exception.rows[0].status === "resolved") throw codedError("INVALID_EXCEPTION_STATE");
  const row = exception.rows[0];
  return {
    exceptionType: row.exception_type,
    severity: row.severity,
    status: row.status,
    sourceType: row.source_type,
    recordType: row.record_type,
    engineRole: typeof row.details?.role === "string" ? row.details.role.slice(0, 40) : null,
    candidateCount: Array.isArray(row.details?.candidateIds) ? row.details.candidateIds.length : null,
    workflowVersion: row.workflow_version,
  };
}

function buildMessages(evidence) {
  return [
    {
      role: "system",
      content: "You assist a human financial reconciliation investigation using category metadata only. Never approve, resolve, alter amounts, invent transactions, or claim knowledge of evidence not supplied. Return one JSON object only with keys likelyCause, confidence, evidence, missingEvidence, nextSteps, cautions. confidence must be low, medium, or high. Each array must contain 1 to 5 short Chinese strings. Because transaction details are intentionally withheld, list the concrete evidence a human must inspect.",
    },
    { role: "user", content: `Analyze this minimized exception metadata:\n${JSON.stringify(evidence)}` },
  ];
}

function boundedText(value, min, max) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

function boundedTextArray(value, minItems, maxItems, maxLength) {
  if (!Array.isArray(value) || value.length < minItems || value.length > 10) return null;
  const items = value.slice(0, maxItems).map((item) => boundedText(item, 1, maxLength));
  return items.every(Boolean) ? items : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codedError(code, metadata = {}) {
  return Object.assign(new Error(code), { code, metadata });
}
