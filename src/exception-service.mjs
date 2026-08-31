import { appendAudit, withTransaction } from "./database.mjs";

const resolutionTypes = new Set([
  "timing_difference", "fee_difference", "duplicate_record",
  "manual_link", "source_correction", "other",
]);

export async function claimException({ pool, tenantId, exceptionId, actorId, assigneeId = actorId, expectedVersion, requestId }) {
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await isOperator(client, tenantId, assigneeId)) throw codedError("INVALID_ASSIGNEE");
    if (exception.status === "resolved" || exception.status === "pending_review") throw codedError("INVALID_EXCEPTION_STATE");
    if (exception.assignee_id && exception.assignee_id !== assigneeId) throw codedError("EXCEPTION_ALREADY_ASSIGNED");
    if (exception.assignee_id === assigneeId && exception.status === "investigating") return workflowResult(exception, true);
    const updated = await client.query(
      `UPDATE recon_exceptions
          SET assignee_id = $3, assigned_at = now(), status = 'investigating', workflow_version = workflow_version + 1
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, exceptionId, assigneeId],
    );
    await appendAudit(client, { tenantId, actorId, action: "exception.claimed", objectType: "recon_exception", objectId: exceptionId, requestId, metadata: { assigneeId } });
    return workflowResult(updated.rows[0], false);
  });
}

export async function releaseException({ pool, tenantId, exceptionId, actorId, expectedVersion, requestId }) {
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await hasRole(client, tenantId, actorId, ["operator"])) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (exception.status !== "investigating" || exception.assignee_id !== actorId) throw codedError("INVALID_EXCEPTION_STATE");
    const updated = await client.query(
      `UPDATE recon_exceptions
          SET assignee_id = NULL, assigned_at = NULL, status = 'open', workflow_version = workflow_version + 1
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [tenantId, exceptionId],
    );
    await appendAudit(client, { tenantId, actorId, action: "exception.released", objectType: "recon_exception", objectId: exceptionId, requestId });
    return workflowResult(updated.rows[0], false);
  });
}

export async function addExceptionNote({ pool, tenantId, exceptionId, actorId, body, expectedVersion, requestId }) {
  const normalized = requiredText(body, 2, 2000, "INVALID_NOTE");
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (exception.status === "resolved") throw codedError("INVALID_EXCEPTION_STATE");
    const role = await memberRole(client, tenantId, actorId);
    if (role === "operator" && exception.assignee_id !== actorId) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (role === "reviewer" && exception.status !== "pending_review") throw codedError("INVALID_WORKFLOW_ACTOR");
    if (!new Set(["operator", "reviewer", "admin"]).has(role)) throw codedError("INVALID_WORKFLOW_ACTOR");
    const note = await client.query(
      `INSERT INTO exception_notes (tenant_id, exception_id, author_id, body)
       VALUES ($1,$2,$3,$4) RETURNING id, author_id, body, created_at`,
      [tenantId, exceptionId, actorId, normalized],
    );
    const updated = await client.query(
      "UPDATE recon_exceptions SET workflow_version = workflow_version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING workflow_version",
      [tenantId, exceptionId],
    );
    await appendAudit(client, { tenantId, actorId, action: "exception.note_added", objectType: "recon_exception", objectId: exceptionId, requestId, metadata: { noteId: note.rows[0].id } });
    return { note: note.rows[0], workflowVersion: updated.rows[0].workflow_version };
  });
}

export async function submitResolution({ pool, tenantId, exceptionId, actorId, resolutionType, summary, financialImpact, replacementRunId, expectedVersion, requestId }) {
  if (!resolutionTypes.has(resolutionType)) throw codedError("INVALID_RESOLUTION_TYPE");
  const normalizedSummary = requiredText(summary, 10, 2000, "INVALID_SUMMARY");
  if (typeof financialImpact !== "boolean") throw codedError("INVALID_FINANCIAL_IMPACT");
  if (financialImpact !== Boolean(replacementRunId)) throw codedError("INVALID_REPLACEMENT_RUN");
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await hasRole(client, tenantId, actorId, ["operator"])) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (exception.status !== "investigating" || exception.assignee_id !== actorId) throw codedError("INVALID_EXCEPTION_STATE");
    const checklist = await client.query(
      `SELECT id FROM exception_investigation_items
        WHERE tenant_id = $1 AND exception_id = $2 AND required = true
          AND (status = 'todo' OR (status = 'not_applicable' AND length(trim(COALESCE(result, ''))) < 2))`,
      [tenantId, exceptionId],
    );
    if (checklist.rowCount) throw codedError("INVESTIGATION_INCOMPLETE", { itemIds: checklist.rows.map((row) => row.id) });
    if (financialImpact) await validateReplacementRun(client, tenantId, exception, replacementRunId);
    const nextVersion = await client.query(
      "SELECT COALESCE(max(proposal_version), 0) + 1 AS version FROM exception_resolution_proposals WHERE exception_id = $1",
      [exceptionId],
    );
    const proposal = await client.query(
      `INSERT INTO exception_resolution_proposals
        (tenant_id, exception_id, proposal_version, resolution_type, summary, financial_impact, replacement_run_id, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, proposal_version, resolution_type, summary, financial_impact, replacement_run_id, submitted_by, created_at`,
      [tenantId, exceptionId, nextVersion.rows[0].version, resolutionType, normalizedSummary, financialImpact, replacementRunId || null, actorId],
    );
    const updated = await client.query(
      `UPDATE recon_exceptions SET status = 'pending_review', workflow_version = workflow_version + 1
        WHERE tenant_id = $1 AND id = $2 RETURNING workflow_version`,
      [tenantId, exceptionId],
    );
    await appendAudit(client, { tenantId, actorId, action: "exception.resolution_submitted", objectType: "recon_exception", objectId: exceptionId, requestId, metadata: { proposalId: proposal.rows[0].id, proposalVersion: proposal.rows[0].proposal_version, financialImpact } });
    return { proposal: proposal.rows[0], status: "pending_review", workflowVersion: updated.rows[0].workflow_version };
  });
}

export async function adoptAiSuggestion({ pool, tenantId, exceptionId, actorId, aiAuditId, decision, selectedSteps = [], reason, expectedVersion, requestId }) {
  if (!Number.isInteger(Number(aiAuditId)) || Number(aiAuditId) < 1) throw codedError("INVALID_AI_AUDIT");
  if (!new Set(["accepted", "partially_accepted", "rejected"]).has(decision)) throw codedError("INVALID_AI_ADOPTION");
  const requestedSteps = normalizeSteps(selectedSteps);
  const normalizedReason = decision === "rejected" ? requiredText(reason, 2, 2000, "INVALID_AI_ADOPTION_REASON") : null;
  if (decision === "partially_accepted" && !requestedSteps.length) throw codedError("AI_PARTIAL_STEPS_REQUIRED");
  if (decision === "rejected" && requestedSteps.length) throw codedError("AI_STEPS_NOT_ALLOWED");
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await hasRole(client, tenantId, actorId, ["operator"])) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (exception.status !== "investigating" || exception.assignee_id !== actorId) throw codedError("INVALID_WORKFLOW_ACTOR");
    const ai = await client.query(
      `SELECT id, metadata FROM audit_events
        WHERE id = $1 AND tenant_id = $2 AND object_type = 'recon_exception'
          AND object_id = $3 AND action = 'ai.exception_suggestion_generated'`,
      [Number(aiAuditId), tenantId, exceptionId],
    );
    if (!ai.rowCount || !ai.rows[0].metadata?.suggestion) throw codedError("INVALID_AI_AUDIT");
    const suggestedSteps = normalizeSteps(ai.rows[0].metadata.suggestion.nextSteps || []);
    const allowed = new Set(suggestedSteps);
    if (requestedSteps.some((step) => !allowed.has(step))) throw codedError("INVALID_AI_STEP");
    if (decision === "partially_accepted" && requestedSteps.length >= suggestedSteps.length) throw codedError("AI_PARTIAL_STEPS_REQUIRED");
    const steps = decision === "accepted" ? suggestedSteps : requestedSteps;
    const existing = await client.query("SELECT id FROM exception_ai_adoptions WHERE exception_id = $1 AND ai_audit_id = $2", [exceptionId, Number(aiAuditId)]);
    if (existing.rowCount) throw codedError("AI_ADOPTION_EXISTS");
    const adoption = await client.query(
      `INSERT INTO exception_ai_adoptions
        (tenant_id, exception_id, ai_audit_id, decision, selected_steps, reason, decided_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       RETURNING id, ai_audit_id, decision, selected_steps, reason, decided_by, created_at`,
      [tenantId, exceptionId, Number(aiAuditId), decision, JSON.stringify(steps), normalizedReason, actorId],
    );
    for (const title of steps) {
      await client.query(
        `INSERT INTO exception_investigation_items
          (tenant_id, exception_id, ai_audit_id, source, title, required, created_by, updated_by)
         VALUES ($1,$2,$3,'ai',$4,true,$5,$5)`,
        [tenantId, exceptionId, Number(aiAuditId), title, actorId],
      );
    }
    const workflowVersion = await bumpWorkflow(client, tenantId, exceptionId);
    await appendAudit(client, {
      tenantId, actorId, action: "exception.ai_adoption_recorded", objectType: "recon_exception", objectId: exceptionId, requestId,
      reason: normalizedReason, metadata: { adoptionId: adoption.rows[0].id, aiAuditId: Number(aiAuditId), decision, selectedSteps: steps },
    });
    return { adoption: adoption.rows[0], workflowVersion };
  });
}

export async function addInvestigationItem({ pool, tenantId, exceptionId, actorId, title, required = true, expectedVersion, requestId }) {
  const normalizedTitle = requiredText(title, 2, 500, "INVALID_INVESTIGATION_ITEM");
  if (typeof required !== "boolean") throw codedError("INVALID_INVESTIGATION_REQUIRED");
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await hasRole(client, tenantId, actorId, ["operator"])) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (exception.status !== "investigating" || exception.assignee_id !== actorId) throw codedError("INVALID_WORKFLOW_ACTOR");
    const item = await client.query(
      `INSERT INTO exception_investigation_items
        (tenant_id, exception_id, source, title, required, created_by, updated_by)
       VALUES ($1,$2,'manual',$3,$4,$5,$5)
       RETURNING *`,
      [tenantId, exceptionId, normalizedTitle, required, actorId],
    );
    const workflowVersion = await bumpWorkflow(client, tenantId, exceptionId);
    await appendAudit(client, { tenantId, actorId, action: "exception.investigation_item_added", objectType: "recon_exception", objectId: exceptionId, requestId, metadata: { itemId: item.rows[0].id, required } });
    return { item: item.rows[0], workflowVersion };
  });
}

export async function updateInvestigationItem({ pool, tenantId, exceptionId, itemId, actorId, status, result, expectedVersion, requestId }) {
  if (!new Set(["todo", "done", "not_applicable"]).has(status)) throw codedError("INVALID_INVESTIGATION_STATUS");
  const rawResult = String(result || "").trim();
  const normalizedResult = status === "todo"
    ? (rawResult ? requiredText(rawResult, 2, 2000, "INVALID_INVESTIGATION_RESULT") : null)
    : requiredText(rawResult, 2, 2000, "INVALID_INVESTIGATION_RESULT");
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await hasRole(client, tenantId, actorId, ["operator"])) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (exception.status !== "investigating" || exception.assignee_id !== actorId) throw codedError("INVALID_WORKFLOW_ACTOR");
    const item = await client.query(
      `UPDATE exception_investigation_items
          SET status = $4, result = $5, updated_by = $6
        WHERE tenant_id = $1 AND exception_id = $2 AND id = $3
        RETURNING *`,
      [tenantId, exceptionId, itemId, status, normalizedResult, actorId],
    );
    if (!item.rowCount) throw codedError("INVESTIGATION_ITEM_NOT_FOUND");
    const workflowVersion = await bumpWorkflow(client, tenantId, exceptionId);
    await appendAudit(client, { tenantId, actorId, action: "exception.investigation_item_updated", objectType: "recon_exception", objectId: exceptionId, requestId, metadata: { itemId, status } });
    return { item: item.rows[0], workflowVersion };
  });
}

export async function decideResolution({ pool, tenantId, exceptionId, actorId, decision, reason, expectedVersion, requestId }) {
  if (!new Set(["approved", "rejected"]).has(decision)) throw codedError("INVALID_DECISION");
  const normalizedReason = decision === "rejected" ? requiredText(reason, 10, 2000, "INVALID_REASON") : optionalText(reason, 2000);
  return withLockedException(pool, tenantId, exceptionId, expectedVersion, async (client, exception) => {
    if (!await hasRole(client, tenantId, actorId, ["reviewer", "admin"])) throw codedError("INVALID_WORKFLOW_ACTOR");
    if (exception.status !== "pending_review") throw codedError("INVALID_EXCEPTION_STATE");
    const proposalResult = await client.query(
      `SELECT p.* FROM exception_resolution_proposals p
        LEFT JOIN exception_resolution_decisions d ON d.proposal_id = p.id
       WHERE p.tenant_id = $1 AND p.exception_id = $2 AND d.id IS NULL
       ORDER BY p.proposal_version DESC LIMIT 1 FOR UPDATE OF p`,
      [tenantId, exceptionId],
    );
    if (!proposalResult.rowCount) throw codedError("INVALID_EXCEPTION_STATE");
    const proposal = proposalResult.rows[0];
    if (proposal.submitted_by === actorId) throw codedError("SELF_APPROVAL_FORBIDDEN");
    if (decision === "approved" && proposal.financial_impact) await validateReplacementRun(client, tenantId, exception, proposal.replacement_run_id);
    const recorded = await client.query(
      `INSERT INTO exception_resolution_decisions (tenant_id, proposal_id, decision, reason, decided_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, decision, reason, decided_by, created_at`,
      [tenantId, proposal.id, decision, normalizedReason, actorId],
    );
    const nextStatus = decision === "approved" ? "resolved" : "investigating";
    const updated = await client.query(
      `UPDATE recon_exceptions
          SET status = $3, resolved_by = $4, resolved_at = CASE WHEN $3 = 'resolved' THEN now() ELSE NULL END,
              workflow_version = workflow_version + 1
        WHERE tenant_id = $1 AND id = $2 RETURNING workflow_version, resolved_at`,
      [tenantId, exceptionId, nextStatus, decision === "approved" ? actorId : null],
    );
    await appendAudit(client, { tenantId, actorId, action: `exception.resolution_${decision}`, objectType: "recon_exception", objectId: exceptionId, requestId, reason: normalizedReason, metadata: { proposalId: proposal.id, proposalVersion: proposal.proposal_version, submittedBy: proposal.submitted_by } });
    return { decision: recorded.rows[0], status: nextStatus, workflowVersion: updated.rows[0].workflow_version, resolvedAt: updated.rows[0].resolved_at };
  });
}

export async function getExceptionDetail(pool, tenantId, exceptionId) {
  const exception = await pool.query(
    `SELECT e.*, c.external_id, c.source_type, c.record_type,
            COALESCE(c.value_date, c.event_at::date) AS business_date,
            r.period_start, r.period_end, r.rule_sha256,
            au.email AS assignee_email, ru.email AS resolved_by_email
       FROM recon_exceptions e
       JOIN recon_runs r ON r.id = e.recon_run_id AND r.tenant_id = e.tenant_id
       LEFT JOIN canonical_records c ON c.id = e.canonical_record_id AND c.tenant_id = e.tenant_id
       LEFT JOIN users au ON au.id = e.assignee_id
       LEFT JOIN users ru ON ru.id = e.resolved_by
      WHERE e.tenant_id = $1 AND e.id = $2`,
    [tenantId, exceptionId],
  );
  if (!exception.rowCount) return null;
  const [notes, proposals, aiSuggestions, adoptions, investigationItems] = await Promise.all([
    pool.query(
      `SELECT n.id, n.author_id, u.email AS author_email, n.body, n.created_at
         FROM exception_notes n JOIN users u ON u.id = n.author_id
        WHERE n.tenant_id = $1 AND n.exception_id = $2 ORDER BY n.created_at, n.id`,
      [tenantId, exceptionId],
    ),
    pool.query(
      `SELECT p.id, p.proposal_version, p.resolution_type, p.summary, p.financial_impact,
              p.replacement_run_id, p.submitted_by, su.email AS submitted_by_email, p.created_at,
              d.decision, d.reason AS decision_reason, d.decided_by, du.email AS decided_by_email, d.created_at AS decided_at
         FROM exception_resolution_proposals p
         JOIN users su ON su.id = p.submitted_by
         LEFT JOIN exception_resolution_decisions d ON d.proposal_id = p.id
         LEFT JOIN users du ON du.id = d.decided_by
        WHERE p.tenant_id = $1 AND p.exception_id = $2 ORDER BY p.proposal_version`,
      [tenantId, exceptionId],
    ),
    pool.query(
      `SELECT a.id, a.actor_id, u.email AS actor_email, a.metadata, a.created_at
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.tenant_id = $1 AND a.object_type = 'recon_exception' AND a.object_id = $2
          AND a.action = 'ai.exception_suggestion_generated'
        ORDER BY a.created_at, a.id`,
      [tenantId, exceptionId],
    ),
    pool.query(
      `SELECT aa.*, u.email AS decided_by_email
         FROM exception_ai_adoptions aa JOIN users u ON u.id = aa.decided_by
        WHERE aa.tenant_id = $1 AND aa.exception_id = $2 ORDER BY aa.created_at, aa.id`,
      [tenantId, exceptionId],
    ),
    pool.query(
      `SELECT i.*, cu.email AS created_by_email, uu.email AS updated_by_email
         FROM exception_investigation_items i
         JOIN users cu ON cu.id = i.created_by
         JOIN users uu ON uu.id = i.updated_by
        WHERE i.tenant_id = $1 AND i.exception_id = $2 ORDER BY i.created_at, i.id`,
      [tenantId, exceptionId],
    ),
  ]);
  return {
    ...exception.rows[0],
    notes: notes.rows,
    proposals: proposals.rows,
    aiSuggestions: aiSuggestions.rows.map(normalizeAiSuggestion).filter(Boolean),
    adoptions: adoptions.rows,
    investigationItems: investigationItems.rows,
  };
}

function normalizeAiSuggestion(row) {
  const metadata = row.metadata;
  if (!metadata || metadata.schemaVersion !== 1 || !metadata.suggestion) return null;
  return {
    auditId: row.id,
    actorId: row.actor_id,
    actorEmail: row.actor_email,
    createdAt: row.created_at,
    provider: metadata.provider,
    model: metadata.model,
    workflowVersion: metadata.workflowVersion,
    suggestion: metadata.suggestion,
  };
}

async function withLockedException(pool, tenantId, exceptionId, expectedVersion, callback) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw codedError("INVALID_WORKFLOW_VERSION");
  return withTransaction(pool, async (client) => {
    const result = await client.query("SELECT * FROM recon_exceptions WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, exceptionId]);
    if (!result.rowCount) throw codedError("EXCEPTION_NOT_FOUND");
    if (result.rows[0].workflow_version !== expectedVersion) throw codedError("STALE_EXCEPTION", { currentVersion: result.rows[0].workflow_version });
    return callback(client, result.rows[0]);
  });
}

async function isOperator(client, tenantId, userId) {
  const result = await client.query("SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2 AND role = 'operator'", [tenantId, userId]);
  return result.rowCount > 0;
}

async function memberRole(client, tenantId, userId) {
  const result = await client.query("SELECT role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
  return result.rows[0]?.role || null;
}

async function hasRole(client, tenantId, userId, roles) {
  return roles.includes(await memberRole(client, tenantId, userId));
}

async function bumpWorkflow(client, tenantId, exceptionId) {
  const updated = await client.query(
    "UPDATE recon_exceptions SET workflow_version = workflow_version + 1 WHERE tenant_id = $1 AND id = $2 RETURNING workflow_version",
    [tenantId, exceptionId],
  );
  return updated.rows[0].workflow_version;
}

async function validateReplacementRun(client, tenantId, exception, runId) {
  const result = await client.query(
    `SELECT id, status, period_start, period_end FROM recon_runs
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, runId],
  );
  if (!result.rowCount || result.rows[0].status !== "completed" || runId === exception.recon_run_id
      || day(result.rows[0].period_start) !== day((await client.query("SELECT period_start FROM recon_runs WHERE id = $1", [exception.recon_run_id])).rows[0].period_start)
      || day(result.rows[0].period_end) !== day((await client.query("SELECT period_end FROM recon_runs WHERE id = $1", [exception.recon_run_id])).rows[0].period_end)) throw codedError("INVALID_REPLACEMENT_RUN");
  const blocking = await client.query("SELECT 1 FROM recon_exceptions WHERE tenant_id = $1 AND recon_run_id = $2 AND severity = 'blocking' AND status <> 'resolved' LIMIT 1", [tenantId, runId]);
  if (blocking.rowCount) throw codedError("INVALID_REPLACEMENT_RUN");
}

function workflowResult(exception, replayed) { return { exceptionId: exception.id, status: exception.status, assigneeId: exception.assignee_id, workflowVersion: exception.workflow_version, replayed }; }
function requiredText(value, min, max, code) { const result = String(value || "").trim(); if (result.length < min || result.length > max) throw codedError(code); return result; }
function optionalText(value, max) { if (value === undefined || value === null || value === "") return null; return requiredText(value, 2, max, "INVALID_REASON"); }
function normalizeSteps(value) {
  if (!Array.isArray(value) || value.length > 10) throw codedError("INVALID_AI_STEPS");
  const steps = value.map((item) => requiredText(item, 2, 500, "INVALID_AI_STEP"));
  if (new Set(steps).size !== steps.length) throw codedError("INVALID_AI_STEPS");
  return steps;
}
function day(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
function codedError(code, metadata = {}) { return Object.assign(new Error(code), { code, metadata }); }
