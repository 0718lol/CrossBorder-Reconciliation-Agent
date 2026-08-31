import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/database.mjs";
import { hashPassword } from "../src/auth.mjs";
import { addExceptionNote, addInvestigationItem, adoptAiSuggestion, claimException, decideResolution, getExceptionDetail, releaseException, submitResolution, updateInvestigationItem } from "../src/exception-service.mjs";
import { closePeriod, createPeriod } from "../src/close-service.mjs";
import { generateExceptionSuggestion, parseSuggestion } from "../src/ai-suggestion-service.mjs";
import { listExceptions } from "../src/workspace-service.mjs";

const enabled = process.env.RUN_DATABASE_TESTS === "1";
const databaseUrl = process.env.DATABASE_URL || "postgres://hyperrecon:hyperrecon_dev_only@127.0.0.1:55432/hyperrecon";
const pool = enabled ? createDatabase(databaseUrl) : null;

const validSuggestion = {
  likelyCause: "可能是来源记录尚未找到对应目标记录",
  confidence: "low",
  evidence: ["异常分类为来源记录未匹配"],
  missingEvidence: ["需要人工核对原始平台记录和结算记录"],
  nextSteps: ["检查来源系统和目标系统的记录范围"],
  cautions: ["不得依据本建议直接修改金额或解除月结阻断"],
};

after(async () => { if (pool) await pool.end(); });

test("AI suggestion parser rejects malformed or incomplete model output", () => {
  assert.deepEqual(parseSuggestion(JSON.stringify(validSuggestion)), validSuggestion);
  assert.equal(parseSuggestion(JSON.stringify({ ...validSuggestion, evidence: ["1", "2", "3", "4", "5", "6"] })).evidence.length, 5);
  assert.throws(() => parseSuggestion("not-json"), { code: "AI_PROVIDER_INVALID_RESPONSE" });
  assert.throws(() => parseSuggestion(JSON.stringify({ ...validSuggestion, confidence: "certain" })), { code: "AI_PROVIDER_INVALID_RESPONSE" });
  assert.throws(() => parseSuggestion(JSON.stringify({ ...validSuggestion, cautions: [] })), { code: "AI_PROVIDER_INVALID_RESPONSE" });
});

test("AI suggestions send minimized metadata and persist only successful output in append-only audit", { skip: !enabled }, async () => {
  const suffix = randomUUID();
  const tenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`AI Suggestion ${suffix}`]);
  const tenantId = tenant.rows[0].id;
  const passwordHash = await hashPassword("ai-suggestion-test-password");
  const operator = await createMember(tenantId, `ai-operator-${suffix}@example.test`, "operator", passwordHash);
  const reviewer = await createMember(tenantId, `ai-reviewer-${suffix}@example.test`, "reviewer", passwordHash);
  const admin = await createMember(tenantId, `ai-admin-${suffix}@example.test`, "admin", passwordHash);
  const runId = await createRun(tenantId, operator, "2026-08-01", "2026-08-31", "ai-suggestion");
  const exception = await pool.query(
    `INSERT INTO recon_exceptions (tenant_id, recon_run_id, exception_type, severity, amount_minor, currency, details, dedupe_key)
     VALUES ($1,$2,'unmatched_source','blocking',987654,'EUR',$3::jsonb,$4) RETURNING id`,
    [tenantId, runId, JSON.stringify({ role: "source", candidateIds: ["private-record-id"] }), `ai-${suffix}`],
  );
  const exceptionId = exception.rows[0].id;
  let transmitted;
  const aiClient = {
    async complete(request) {
      transmitted = request;
      return { provider: "deepseek", model: "deepseek-v4-flash", content: JSON.stringify(validSuggestion), usage: { totalTokens: 80 }, providerRequestId: null };
    },
  };

  const generated = await generateExceptionSuggestion({ pool, aiClient, tenantId, exceptionId, actorId: operator, requestId: suffix });
  assert.equal(generated.suggestion.confidence, "low");
  assert.equal(transmitted.responseFormat, "json_object");
  const serialized = JSON.stringify(transmitted.messages);
  for (const forbidden of ["987654", "EUR", "private-record-id", tenantId, `ai-operator-${suffix}@example.test`]) {
    assert.equal(serialized.includes(forbidden), false, `must not transmit ${forbidden}`);
  }

  const audit = await pool.query("SELECT id, metadata FROM audit_events WHERE id = $1 AND tenant_id = $2", [generated.auditId, tenantId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].metadata.suggestion.likelyCause, validSuggestion.likelyCause);
  await assert.rejects(pool.query("UPDATE audit_events SET metadata = '{}' WHERE id = $1", [generated.auditId]), /append-only/);
  await assert.rejects(pool.query("DELETE FROM audit_events WHERE id = $1", [generated.auditId]), /append-only/);

  const claimed = await claimException({ pool, tenantId, exceptionId, actorId: operator, expectedVersion: 0, requestId: suffix });
  await assert.rejects(
    adoptAiSuggestion({ pool, tenantId, exceptionId, actorId: operator, aiAuditId: generated.auditId, decision: "partially_accepted", selectedSteps: [], expectedVersion: claimed.workflowVersion, requestId: suffix }),
    { code: "AI_PARTIAL_STEPS_REQUIRED" },
  );
  await assert.rejects(
    adoptAiSuggestion({ pool, tenantId, exceptionId, actorId: operator, aiAuditId: generated.auditId, decision: "partially_accepted", selectedSteps: validSuggestion.nextSteps, expectedVersion: claimed.workflowVersion, requestId: suffix }),
    { code: "AI_PARTIAL_STEPS_REQUIRED" },
  );
  await assert.rejects(
    adoptAiSuggestion({ pool, tenantId, exceptionId, actorId: operator, aiAuditId: generated.auditId, decision: "rejected", selectedSteps: [], expectedVersion: claimed.workflowVersion, requestId: suffix }),
    { code: "INVALID_AI_ADOPTION_REASON" },
  );
  const adopted = await adoptAiSuggestion({
    pool, tenantId, exceptionId, actorId: operator, aiAuditId: generated.auditId, decision: "accepted",
    selectedSteps: [], expectedVersion: claimed.workflowVersion, requestId: suffix,
  });
  assert.equal(adopted.workflowVersion, 2);
  await assert.rejects(
    adoptAiSuggestion({ pool, tenantId, exceptionId, actorId: reviewer, aiAuditId: generated.auditId, decision: "accepted", selectedSteps: validSuggestion.nextSteps, expectedVersion: 2, requestId: suffix }),
    { code: "INVALID_WORKFLOW_ACTOR" },
  );
  await assert.rejects(
    submitResolution({ pool, tenantId, exceptionId, actorId: operator, resolutionType: "other", summary: "Checklist is not complete yet.", financialImpact: false, expectedVersion: 2, requestId: suffix }),
    { code: "INVESTIGATION_INCOMPLETE" },
  );
  const adoptedDetail = await getExceptionDetail(pool, tenantId, exceptionId);
  assert.equal(adoptedDetail.adoptions.length, 1);
  assert.equal(adoptedDetail.investigationItems.length, 1);
  const completed = await updateInvestigationItem({
    pool, tenantId, exceptionId, itemId: adoptedDetail.investigationItems[0].id, actorId: operator,
    status: "done", result: "人工核对完成，证据与建议步骤一致。", expectedVersion: 2, requestId: suffix,
  });
  assert.equal(completed.workflowVersion, 3);
  const manual = await addInvestigationItem({
    pool, tenantId, exceptionId, actorId: operator, title: "补充核对平台结算范围", required: false,
    expectedVersion: 3, requestId: suffix,
  });
  assert.equal(manual.workflowVersion, 4);
  const submitted = await submitResolution({
    pool, tenantId, exceptionId, actorId: operator, resolutionType: "other",
    summary: "Required AI investigation step was checked and documented.", financialImpact: false,
    expectedVersion: 4, requestId: suffix,
  });
  assert.equal(submitted.status, "pending_review");

  const adoptionAudit = await pool.query(
    "SELECT metadata FROM audit_events WHERE tenant_id = $1 AND action = 'exception.ai_adoption_recorded' AND object_id = $2",
    [tenantId, exceptionId],
  );
  assert.equal(adoptionAudit.rowCount, 1);
  assert.deepEqual(adoptionAudit.rows[0].metadata.selectedSteps, validSuggestion.nextSteps);

  await generateExceptionSuggestion({ pool, aiClient, tenantId, exceptionId, actorId: reviewer, requestId: `${suffix}-reviewer` });
  const listed = await listExceptions(pool, tenantId, { status: "active" });
  assert.equal(listed.find((item) => item.id === exceptionId)?.ai_suggestion_count, 2);
  await assert.rejects(
    generateExceptionSuggestion({ pool, aiClient, tenantId, exceptionId, actorId: admin, requestId: `${suffix}-admin` }),
    { code: "INVALID_WORKFLOW_ACTOR" },
  );

  const beforeFailure = await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND action = 'ai.exception_suggestion_generated'", [tenantId]);
  const invalidClient = { async complete() { return { provider: "deepseek", model: "deepseek-v4-flash", content: "{}", usage: null, providerRequestId: null }; } };
  await assert.rejects(
    generateExceptionSuggestion({ pool, aiClient: invalidClient, tenantId, exceptionId, actorId: operator, requestId: `${suffix}-invalid` }),
    { code: "AI_PROVIDER_INVALID_RESPONSE" },
  );
  const afterFailure = await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND action = 'ai.exception_suggestion_generated'", [tenantId]);
  assert.equal(afterFailure.rows[0].count, beforeFailure.rows[0].count);
});

test("exception workflow enforces ownership, four-eyes review, history, and close blocking", { skip: !enabled }, async () => {
  const suffix = randomUUID();
  const tenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Exception Workflow ${suffix}`]);
  const otherTenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Exception Isolation ${suffix}`]);
  const tenantId = tenant.rows[0].id;
  const passwordHash = await hashPassword("exception-workflow-password");
  const operator = await createMember(tenantId, `operator-${suffix}@example.test`, "operator", passwordHash);
  const otherOperator = await createMember(tenantId, `other-operator-${suffix}@example.test`, "operator", passwordHash);
  const reviewer = await createMember(tenantId, `reviewer-${suffix}@example.test`, "reviewer", passwordHash);
  const secondReviewer = await createMember(tenantId, `reviewer-two-${suffix}@example.test`, "reviewer", passwordHash);
  const periodStart = "2026-08-01";
  const periodEnd = "2026-08-31";
  const originalRun = await createRun(tenantId, operator, periodStart, periodEnd, "original");
  const exception = await pool.query(
    `INSERT INTO recon_exceptions
      (tenant_id, recon_run_id, exception_type, severity, amount_minor, currency, dedupe_key)
     VALUES ($1,$2,'unmatched_source','blocking',10000,'USD',$3) RETURNING id`,
    [tenantId, originalRun, `workflow-${suffix}`],
  );
  const exceptionId = exception.rows[0].id;
  const period = await createPeriod({ pool, tenantId, actorId: reviewer, requestId: suffix, periodStart, periodEnd });

  await assert.rejects(
    closePeriod({ pool, tenantId, periodId: period.periodId, runIds: [originalRun], actorId: reviewer, requestId: suffix }),
    (error) => error.code === "CLOSE_BLOCKED",
  );
  await assert.rejects(
    claimException({ pool, tenantId, exceptionId, actorId: otherOperator, assigneeId: otherOperator, expectedVersion: 1, requestId: suffix }),
    (error) => error.code === "STALE_EXCEPTION",
  );

  const claimed = await claimException({ pool, tenantId, exceptionId, actorId: operator, expectedVersion: 0, requestId: suffix });
  assert.equal(claimed.status, "investigating");
  assert.equal(claimed.workflowVersion, 1);
  await assert.rejects(
    claimException({ pool, tenantId, exceptionId, actorId: otherOperator, expectedVersion: 1, requestId: suffix }),
    (error) => error.code === "EXCEPTION_ALREADY_ASSIGNED",
  );

  const note = await addExceptionNote({ pool, tenantId, exceptionId, actorId: operator, body: "Provider statement confirms a timing difference.", expectedVersion: 1, requestId: suffix });
  assert.equal(note.workflowVersion, 2);
  const submitted = await submitResolution({
    pool, tenantId, exceptionId, actorId: operator, resolutionType: "timing_difference",
    summary: "The settlement belongs to the following processing day.", financialImpact: false,
    expectedVersion: 2, requestId: suffix,
  });
  assert.equal(submitted.status, "pending_review");
  await pool.query("UPDATE tenant_members SET role = 'reviewer' WHERE tenant_id = $1 AND user_id = $2", [tenantId, operator]);
  await assert.rejects(
    decideResolution({ pool, tenantId, exceptionId, actorId: operator, decision: "approved", expectedVersion: 3, requestId: suffix }),
    (error) => error.code === "SELF_APPROVAL_FORBIDDEN",
  );
  await pool.query("UPDATE tenant_members SET role = 'operator' WHERE tenant_id = $1 AND user_id = $2", [tenantId, operator]);

  const rejected = await decideResolution({ pool, tenantId, exceptionId, actorId: reviewer, decision: "rejected", reason: "Please attach the provider settlement date evidence.", expectedVersion: 3, requestId: suffix });
  assert.equal(rejected.status, "investigating");
  const resubmitted = await submitResolution({
    pool, tenantId, exceptionId, actorId: operator, resolutionType: "timing_difference",
    summary: "Provider statement dated next day confirms settlement timing.", financialImpact: false,
    expectedVersion: 4, requestId: suffix,
  });
  assert.equal(resubmitted.proposal.proposal_version, 2);
  const approved = await decideResolution({ pool, tenantId, exceptionId, actorId: secondReviewer, decision: "approved", reason: "Evidence reviewed.", expectedVersion: 5, requestId: suffix });
  assert.equal(approved.status, "resolved");

  const detail = await getExceptionDetail(pool, tenantId, exceptionId);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.proposals.length, 2);
  assert.equal(detail.proposals[0].decision, "rejected");
  assert.equal(detail.proposals[1].decision, "approved");
  assert.equal(await getExceptionDetail(pool, otherTenant.rows[0].id, exceptionId), null);
  await assert.rejects(pool.query("UPDATE exception_notes SET body = 'tampered' WHERE exception_id = $1", [exceptionId]), /immutable/);
  await assert.rejects(pool.query("DELETE FROM exception_resolution_proposals WHERE exception_id = $1", [exceptionId]), /immutable/);

  const closed = await closePeriod({ pool, tenantId, periodId: period.periodId, runIds: [originalRun], actorId: reviewer, requestId: suffix });
  assert.equal(closed.status, "locked");
});

test("financial-impact resolution requires a clean replacement run for the same period", { skip: !enabled }, async () => {
  const suffix = randomUUID();
  const tenant = await pool.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [`Financial Resolution ${suffix}`]);
  const tenantId = tenant.rows[0].id;
  const passwordHash = await hashPassword("financial-resolution-password");
  const operator = await createMember(tenantId, `financial-operator-${suffix}@example.test`, "operator", passwordHash);
  const reviewer = await createMember(tenantId, `financial-reviewer-${suffix}@example.test`, "reviewer", passwordHash);
  const originalRun = await createRun(tenantId, operator, "2026-08-01", "2026-08-31", "financial-original");
  const replacementRun = await createRun(tenantId, operator, "2026-08-01", "2026-08-31", "financial-replacement");
  const wrongPeriodRun = await createRun(tenantId, operator, "2026-09-01", "2026-09-30", "wrong-period");
  const exception = await pool.query(
    `INSERT INTO recon_exceptions (tenant_id, recon_run_id, exception_type, severity, amount_minor, currency, dedupe_key)
     VALUES ($1,$2,'unmatched_target','blocking',300,'USD',$3) RETURNING id`,
    [tenantId, originalRun, `financial-${suffix}`],
  );
  const exceptionId = exception.rows[0].id;
  await claimException({ pool, tenantId, exceptionId, actorId: operator, expectedVersion: 0, requestId: suffix });
  await assert.rejects(
    submitResolution({ pool, tenantId, exceptionId, actorId: operator, resolutionType: "fee_difference", summary: "Fee changes the financial allocation.", financialImpact: true, replacementRunId: wrongPeriodRun, expectedVersion: 1, requestId: suffix }),
    (error) => error.code === "INVALID_REPLACEMENT_RUN",
  );
  const submitted = await submitResolution({ pool, tenantId, exceptionId, actorId: operator, resolutionType: "fee_difference", summary: "Fee is represented in a clean replacement reconciliation run.", financialImpact: true, replacementRunId: replacementRun, expectedVersion: 1, requestId: suffix });
  assert.equal(submitted.proposal.replacement_run_id, replacementRun);
  const approved = await decideResolution({ pool, tenantId, exceptionId, actorId: reviewer, decision: "approved", expectedVersion: 2, requestId: suffix });
  assert.equal(approved.status, "resolved");
  const period = await createPeriod({ pool, tenantId, actorId: reviewer, requestId: suffix, periodStart: "2026-08-01", periodEnd: "2026-08-31" });
  await assert.rejects(
    closePeriod({ pool, tenantId, periodId: period.periodId, runIds: [originalRun], actorId: reviewer, requestId: suffix }),
    (error) => error.code === "INVALID_RUN_SET" && error.metadata.replacementRunId === replacementRun,
  );
  const closed = await closePeriod({ pool, tenantId, periodId: period.periodId, runIds: [replacementRun], actorId: reviewer, requestId: suffix });
  assert.equal(closed.status, "locked");
});

async function createMember(tenantId, email, role, passwordHash) {
  const user = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [email, passwordHash]);
  await pool.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,$3::member_role)", [tenantId, user.rows[0].id, role]);
  return user.rows[0].id;
}

async function createRun(tenantId, actorId, periodStart, periodEnd, key) {
  const result = await pool.query(
    `INSERT INTO recon_runs
      (tenant_id, period_start, period_end, status, rule_definition, rule_sha256, engine_version,
       record_highwater, idempotency_key, stats, created_by, completed_at)
     VALUES ($1,$2,$3,'completed','{}',repeat('a',64),'test-engine',now(),$4,'{}',$5,now()) RETURNING id`,
    [tenantId, periodStart, periodEnd, `${key}-${randomUUID()}`, actorId],
  );
  return result.rows[0].id;
}
