import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appendAudit, authenticateSession, authorizeRequest, createDatabase, withTransaction } from "./database.mjs";
import { hashPassword, hashSessionToken, secretsEqual, validateEmail } from "./auth.mjs";
import { loadConfig } from "./config.mjs";
import { importCsv } from "./import-service.mjs";
import { runReconciliation } from "./recon-service.mjs";
import { closePeriod, createPeriod, reopenPeriod } from "./close-service.mjs";
import { createSessionForCredentials } from "./session-service.mjs";
import { demoAccounts } from "./demo-accounts.mjs";
import { getMoneyFlow, getPeriodArchive, getWorkspaceSnapshot, listExceptions, listSources } from "./workspace-service.mjs";
import { addExceptionNote, addInvestigationItem, adoptAiSuggestion, claimException, decideResolution, getExceptionDetail, releaseException, submitResolution, updateInvestigationItem } from "./exception-service.mjs";
import { createDeepSeekClient } from "./ai-service.mjs";
import { generateExceptionSuggestion } from "./ai-suggestion-service.mjs";

const config = loadConfig();
const pool = createDatabase(config.databaseUrl);
const aiClient = config.deepseekApiKey ? createDeepSeekClient({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  timeoutMs: config.deepseekTimeoutMs,
}) : null;
const dummyPasswordHash = await hashPassword("foundation-dummy-password-not-an-account");
const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.x-bootstrap-token", "body.password"] }, bodyLimit: config.maxUploadBytes + 1024 * 1024 });
await app.register(multipart, { limits: { files: 1, fileSize: config.maxUploadBytes, fields: 5 } });

app.addHook("onRequest", async (request, reply) => {
  const externalRequestId = request.headers["x-request-id"];
  request.requestId = typeof externalRequestId === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(externalRequestId) ? externalRequestId : randomUUID();
  reply.header("x-request-id", request.requestId);
});

app.get("/live", async () => ({ status: "ok", version: "0.2.0" }));

app.get("/ready", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", version: "0.2.0" };
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", version: "0.2.0" };
});

app.get("/", async (_request, reply) => reply.redirect("/console/"));
app.get("/console/", async (_request, reply) => sendConsoleAsset(reply, "index.html", "text/html; charset=utf-8"));
app.get("/console/app.js", async (_request, reply) => sendConsoleAsset(reply, "app.js", "text/javascript; charset=utf-8"));
app.get("/console/role-model.js", async (_request, reply) => sendConsoleAsset(reply, "role-model.js", "text/javascript; charset=utf-8"));
app.get("/console/styles.css", async (_request, reply) => sendConsoleAsset(reply, "styles.css", "text/css; charset=utf-8"));

app.get("/v1/demo-accounts", async (_request, reply) => {
  if (!config.demoMode) return reply.code(404).send(errorBody("NOT_FOUND", "demo-mode-disabled"));
  return { data: demoAccounts.map(({ role, label, description, email, password }) => ({ role, label, description, email, password })) };
});

app.post("/v1/bootstrap", async (request, reply) => {
  if (!config.bootstrapToken || !secretsEqual(request.headers["x-bootstrap-token"], config.bootstrapToken)) return reply.code(403).send(errorBody("FORBIDDEN", request.requestId));
  const body = request.body || {};
  let email;
  try { email = validateEmail(body.email); }
  catch { return reply.code(400).send(errorBody("INVALID_EMAIL", request.requestId)); }
  if (!body.tenantName || String(body.tenantName).trim().length > 120) return reply.code(400).send(errorBody("INVALID_TENANT_NAME", request.requestId));
  let passwordHash;
  try { passwordHash = await hashPassword(body.password); }
  catch { return reply.code(400).send(errorBody("INVALID_PASSWORD", request.requestId)); }
  const result = await withTransaction(pool, async (client) => {
    const tenant = await client.query("INSERT INTO tenants (name) VALUES ($1) RETURNING id", [String(body.tenantName).trim()]);
    const user = await client.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [email, passwordHash]);
    await client.query("INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,'admin')", [tenant.rows[0].id, user.rows[0].id]);
    const sources = {};
    for (const sourceType of ["stripe", "paypal", "wise", "bank", "shopify"]) {
      const source = await client.query("INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1,$2,$3) RETURNING id", [tenant.rows[0].id, `${sourceType}-default`, sourceType]);
      sources[sourceType] = source.rows[0].id;
    }
    await appendAudit(client, { tenantId: tenant.rows[0].id, actorId: user.rows[0].id, action: "tenant.bootstrapped", objectType: "tenant", objectId: tenant.rows[0].id, requestId: request.requestId });
    return { tenantId: tenant.rows[0].id, userId: user.rows[0].id, sources };
  });
  return reply.code(201).send(result);
});

app.post("/v1/sessions", async (request, reply) => {
  try {
    return await createSessionForCredentials({
      pool,
      email: request.body?.email,
      password: request.body?.password,
      tenantId: request.body?.tenantId,
      dummyPasswordHash,
      sessionTtlSeconds: config.sessionTtlSeconds,
      requestId: request.requestId,
    });
  } catch (error) {
    if (error.code === "WORKSPACE_REQUIRED") return reply.code(409).send(errorBody(error.code, request.requestId, error.metadata));
    if (error.code === "INVALID_CREDENTIALS") return reply.code(401).send(errorBody(error.code, request.requestId));
    throw error;
  }
});

app.delete("/v1/sessions/current", async (request, reply) => {
  const token = bearerToken(request.headers.authorization);
  if (!token) return reply.code(401).send(errorBody("UNAUTHORIZED", request.requestId));
  await pool.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [hashSessionToken(token)]);
  return reply.code(204).send();
});

app.post("/v1/tenants/:tenantId/sources/:sourceId/import-batches", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "admin"]);
  if (!identity) return;
  const source = await pool.query("SELECT source_type FROM data_sources WHERE id = $1 AND tenant_id = $2", [request.params.sourceId, identity.tenantId]);
  if (!source.rowCount) return reply.code(404).send(errorBody("SOURCE_NOT_FOUND", request.requestId));
  const file = await request.file();
  if (!file) return reply.code(400).send(errorBody("FILE_REQUIRED", request.requestId));
  let buffer;
  try { buffer = await file.toBuffer(); }
  catch (error) { return reply.code(error.code === "FST_REQ_FILE_TOO_LARGE" ? 413 : 400).send(errorBody("INVALID_UPLOAD", request.requestId)); }
  const result = await importCsv({ pool, objectStorageDir: config.objectStorageDir, tenantId: identity.tenantId, dataSourceId: request.params.sourceId, sourceType: source.rows[0].source_type, filename: file.filename, buffer, actorId: identity.userId, requestId: request.requestId, maxBytes: config.maxUploadBytes });
  const status = result.status === "preflight_failed" ? 422 : result.replayed ? 200 : 201;
  return reply.code(status).send(result);
});

app.get("/v1/tenants/:tenantId/import-batches", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  const result = await pool.query(
    `SELECT id, data_source_id, sha256, original_filename, byte_size, status, row_count, error_count, created_at, committed_at
       FROM import_batches WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [identity.tenantId],
  );
  return { data: result.rows };
});

app.get("/v1/tenants/:tenantId/workspace", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  return { ...(await getWorkspaceSnapshot(pool, identity.tenantId, identity.role)), userId: identity.userId };
});

app.get("/v1/tenants/:tenantId/sources", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  return { data: await listSources(pool, identity.tenantId) };
});

app.get("/v1/tenants/:tenantId/operators", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["admin"]);
  if (!identity) return;
  const result = await pool.query(
    `SELECT u.id, u.email FROM tenant_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1 AND tm.role = 'operator' AND u.status = 'active'
      ORDER BY lower(u.email)`,
    [identity.tenantId],
  );
  return { data: result.rows };
});

app.get("/v1/tenants/:tenantId/money-flow", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  return getMoneyFlow(pool, identity.tenantId);
});

app.get("/v1/tenants/:tenantId/exceptions", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  return { data: await listExceptions(pool, identity.tenantId, request.query) };
});

app.get("/v1/tenants/:tenantId/exceptions/:exceptionId", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  const detail = await getExceptionDetail(pool, identity.tenantId, request.params.exceptionId);
  if (!detail) return reply.code(404).send(errorBody("EXCEPTION_NOT_FOUND", request.requestId));
  return detail;
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/claim", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "admin"]);
  if (!identity) return;
  const assigneeId = identity.role === "admin" ? request.body?.assigneeId : identity.userId;
  const result = await claimException({ pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId, assigneeId, expectedVersion: request.body?.expectedVersion, requestId: request.requestId });
  return reply.code(result.replayed ? 200 : 201).send(result);
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/release", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator"]);
  if (!identity) return;
  return releaseException({ pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId, expectedVersion: request.body?.expectedVersion, requestId: request.requestId });
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/notes", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin"]);
  if (!identity) return;
  const result = await addExceptionNote({ pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId, body: request.body?.body, expectedVersion: request.body?.expectedVersion, requestId: request.requestId });
  return reply.code(201).send(result);
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/resolution-proposals", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator"]);
  if (!identity) return;
  const result = await submitResolution({ pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId, resolutionType: request.body?.resolutionType, summary: request.body?.summary, financialImpact: request.body?.financialImpact, replacementRunId: request.body?.replacementRunId, expectedVersion: request.body?.expectedVersion, requestId: request.requestId });
  return reply.code(201).send(result);
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/resolution-decisions", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["reviewer", "admin"]);
  if (!identity) return;
  const result = await decideResolution({ pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId, decision: request.body?.decision, reason: request.body?.reason, expectedVersion: request.body?.expectedVersion, requestId: request.requestId });
  return reply.code(201).send(result);
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/ai-suggestions", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer"]);
  if (!identity) return;
  const result = await generateExceptionSuggestion({
    pool,
    aiClient,
    tenantId: identity.tenantId,
    exceptionId: request.params.exceptionId,
    actorId: identity.userId,
    requestId: request.requestId,
  });
  return reply.code(201).send(result);
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/ai-suggestions/:auditId/adoption", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator"]);
  if (!identity) return;
  const result = await adoptAiSuggestion({
    pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId,
    aiAuditId: request.params.auditId, decision: request.body?.decision, selectedSteps: request.body?.selectedSteps,
    reason: request.body?.reason, expectedVersion: request.body?.expectedVersion, requestId: request.requestId,
  });
  return reply.code(201).send(result);
});

app.post("/v1/tenants/:tenantId/exceptions/:exceptionId/investigation-items", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator"]);
  if (!identity) return;
  const result = await addInvestigationItem({
    pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, actorId: identity.userId,
    title: request.body?.title, required: request.body?.required, expectedVersion: request.body?.expectedVersion, requestId: request.requestId,
  });
  return reply.code(201).send(result);
});

app.patch("/v1/tenants/:tenantId/exceptions/:exceptionId/investigation-items/:itemId", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator"]);
  if (!identity) return;
  return updateInvestigationItem({
    pool, tenantId: identity.tenantId, exceptionId: request.params.exceptionId, itemId: request.params.itemId,
    actorId: identity.userId, status: request.body?.status, result: request.body?.result,
    expectedVersion: request.body?.expectedVersion, requestId: request.requestId,
  });
});

app.get("/v1/tenants/:tenantId/audit-events", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["admin", "auditor"]);
  if (!identity) return;
  const result = await pool.query(
    `SELECT id, actor_id, action, object_type, object_id, request_id, reason, metadata, created_at
       FROM audit_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 200`,
    [identity.tenantId],
  );
  return { data: result.rows };
});

app.post("/v1/tenants/:tenantId/recon-runs", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "admin"]);
  if (!identity) return;
  const result = await runReconciliation({
    pool,
    tenantId: identity.tenantId,
    actorId: identity.userId,
    requestId: request.requestId,
    idempotencyKey: request.headers["idempotency-key"],
    periodStart: request.body?.periodStart,
    periodEnd: request.body?.periodEnd,
    rule: request.body?.rule,
  });
  return reply.code(result.replayed ? 200 : 201).send(result);
});

app.get("/v1/tenants/:tenantId/recon-runs", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  const result = await pool.query(
    `SELECT r.id, r.period_start, r.period_end, r.status, r.rule_sha256, r.engine_version, r.record_highwater,
            r.idempotency_key, r.stats, r.error, r.started_at, r.completed_at,
            (SELECT count(*)::int FROM recon_exceptions e
              WHERE e.recon_run_id = r.id AND e.tenant_id = r.tenant_id
                AND e.severity = 'blocking' AND e.status <> 'resolved') AS open_blocking_exception_count
       FROM recon_runs r WHERE r.tenant_id = $1 ORDER BY r.started_at DESC LIMIT 100`,
    [identity.tenantId],
  );
  return { data: result.rows };
});

app.get("/v1/tenants/:tenantId/recon-runs/:runId", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  const run = await pool.query(
    `SELECT r.id, r.period_start, r.period_end, r.status, r.rule_definition, r.rule_sha256, r.engine_version,
            r.record_highwater, r.stats, r.error, r.started_at, r.completed_at,
            (SELECT count(*)::int FROM recon_exceptions e
              WHERE e.recon_run_id = r.id AND e.tenant_id = r.tenant_id
                AND e.severity = 'blocking' AND e.status <> 'resolved') AS open_blocking_exception_count
       FROM recon_runs r WHERE r.id = $1 AND r.tenant_id = $2`,
    [request.params.runId, identity.tenantId],
  );
  if (!run.rowCount) return reply.code(404).send(errorBody("RUN_NOT_FOUND", request.requestId));
  const groups = await pool.query(
    `SELECT g.id, g.match_type, g.currency, g.amount_minor, g.evidence,
            json_agg(json_build_object('recordId', a.canonical_record_id, 'role', a.role,
              'allocatedMinor', a.allocated_minor, 'ruleStep', a.rule_step) ORDER BY a.role, a.id) AS allocations
       FROM match_groups g JOIN record_allocations a ON a.match_group_id = g.id
      WHERE g.recon_run_id = $1 AND g.tenant_id = $2 GROUP BY g.id ORDER BY g.created_at, g.id`,
    [request.params.runId, identity.tenantId],
  );
  const exceptions = await pool.query(
    `SELECT id, canonical_record_id, exception_type, severity, status, amount_minor, currency, details, created_at
       FROM recon_exceptions WHERE recon_run_id = $1 AND tenant_id = $2 ORDER BY created_at, id`,
    [request.params.runId, identity.tenantId],
  );
  return { ...run.rows[0], groups: groups.rows, exceptions: exceptions.rows };
});

app.post("/v1/tenants/:tenantId/periods", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["reviewer", "admin"]);
  if (!identity) return;
  const result = await createPeriod({ pool, tenantId: identity.tenantId, actorId: identity.userId, requestId: request.requestId, periodStart: request.body?.periodStart, periodEnd: request.body?.periodEnd });
  return reply.code(result.replayed ? 200 : 201).send(result);
});

app.post("/v1/tenants/:tenantId/periods/:periodId/close", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["reviewer", "admin"]);
  if (!identity) return;
  const result = await closePeriod({ pool, tenantId: identity.tenantId, periodId: request.params.periodId, runIds: request.body?.runIds, actorId: identity.userId, requestId: request.requestId });
  return reply.code(200).send(result);
});

app.post("/v1/tenants/:tenantId/periods/:periodId/reopen", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["admin"]);
  if (!identity) return;
  const result = await reopenPeriod({ pool, tenantId: identity.tenantId, periodId: request.params.periodId, actorId: identity.userId, requestId: request.requestId, reason: request.body?.reason });
  return reply.code(result.replayed ? 200 : 201).send(result);
});

app.get("/v1/tenants/:tenantId/periods", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["reviewer", "admin", "auditor"]);
  if (!identity) return;
  const result = await pool.query(
    `SELECT id, period_start, period_end, version, status, parent_period_id, manifest_sha256,
            reopen_reason, created_by, closed_by, created_at, locked_at
       FROM close_periods WHERE tenant_id = $1 ORDER BY period_start DESC, version DESC LIMIT 100`,
    [identity.tenantId],
  );
  return { data: result.rows };
});

app.get("/v1/tenants/:tenantId/periods/:periodId", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["reviewer", "admin", "auditor"]);
  if (!identity) return;
  const archive = await getPeriodArchive(pool, identity.tenantId, request.params.periodId);
  if (!archive) return reply.code(404).send(errorBody("PERIOD_NOT_FOUND", request.requestId));
  return archive;
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, requestId: request.requestId }, "request failed");
  if (error.code === "23505") return reply.code(409).send(errorBody("CONFLICT", request.requestId));
  if (["PERIOD_LOCKED", "CLOSE_BLOCKED", "INVALID_PERIOD_STATE", "EXCEPTION_ALREADY_ASSIGNED", "STALE_EXCEPTION", "AI_ADOPTION_EXISTS", "INVESTIGATION_INCOMPLETE"].includes(error.code)) return reply.code(409).send(errorBody(error.code, request.requestId, error.metadata));
  if (["PERIOD_NOT_FOUND", "EXCEPTION_NOT_FOUND", "INVESTIGATION_ITEM_NOT_FOUND"].includes(error.code)) return reply.code(404).send(errorBody(error.code, request.requestId));
  if (["SELF_APPROVAL_FORBIDDEN"].includes(error.code)) return reply.code(403).send(errorBody(error.code, request.requestId));
  if (["AI_NOT_CONFIGURED", "AI_PROVIDER_UNAVAILABLE", "AI_PROVIDER_TIMEOUT"].includes(error.code)) return reply.code(503).send(errorBody(error.code, request.requestId));
  if (["AI_PROVIDER_AUTH_FAILED", "AI_PROVIDER_ERROR", "AI_PROVIDER_INVALID_RESPONSE"].includes(error.code)) return reply.code(502).send(errorBody(error.code, request.requestId));
  if (["AI_PARTIAL_STEPS_REQUIRED", "AI_STEPS_NOT_ALLOWED"].includes(error.code)) return reply.code(400).send(errorBody(error.code, request.requestId));
  if (String(error.code || "").startsWith("INVALID_")) return reply.code(400).send(errorBody(error.code, request.requestId, error.metadata));
  return reply.code(500).send(errorBody("INTERNAL_ERROR", request.requestId));
});

async function requireIdentity(request, reply, allowedRoles) {
  const token = bearerToken(request.headers.authorization);
  if (!token) { reply.code(401).send(errorBody("UNAUTHORIZED", request.requestId)); return null; }
  const tokenHash = hashSessionToken(token);
  if (!(await authenticateSession(pool, tokenHash))) { reply.code(401).send(errorBody("UNAUTHORIZED", request.requestId)); return null; }
  const identity = await authorizeRequest(pool, tokenHash, request.params.tenantId, allowedRoles);
  if (!identity) { reply.code(403).send(errorBody("FORBIDDEN", request.requestId)); return null; }
  return identity;
}

function bearerToken(header) {
  const match = String(header || "").match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  return match?.[1] || null;
}

function errorBody(code, requestId, metadata) { return { error: { code, requestId, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) } }; }

async function sendConsoleAsset(reply, filename, contentType) {
  const body = await readFile(new URL(`../public/console/${filename}`, import.meta.url));
  return reply.header("cache-control", "no-store").type(contentType).send(body);
}

const shutdown = async () => { await app.close(); await pool.end(); };
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
await app.listen({ host: process.env.HOST || "0.0.0.0", port: config.port });
