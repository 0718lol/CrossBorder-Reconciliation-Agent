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
import { getWorkspaceSnapshot, listExceptions, listSources } from "./workspace-service.mjs";

const config = loadConfig();
const pool = createDatabase(config.databaseUrl);
const dummyPasswordHash = await hashPassword("foundation-dummy-password-not-an-account");
const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.x-bootstrap-token", "body.password"] }, bodyLimit: config.maxUploadBytes + 1024 * 1024 });
await app.register(multipart, { limits: { files: 1, fileSize: config.maxUploadBytes, fields: 5 } });

app.addHook("onRequest", async (request, reply) => {
  const externalRequestId = request.headers["x-request-id"];
  request.requestId = typeof externalRequestId === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(externalRequestId) ? externalRequestId : randomUUID();
  reply.header("x-request-id", request.requestId);
});

app.get("/health", async () => {
  await pool.query("SELECT 1");
  return { status: "ok", version: "0.2.0" };
});

app.get("/", async (_request, reply) => reply.redirect("/console/"));
app.get("/console/", async (_request, reply) => sendConsoleAsset(reply, "index.html", "text/html; charset=utf-8"));
app.get("/console/app.js", async (_request, reply) => sendConsoleAsset(reply, "app.js", "text/javascript; charset=utf-8"));
app.get("/console/styles.css", async (_request, reply) => sendConsoleAsset(reply, "styles.css", "text/css; charset=utf-8"));

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
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin"]);
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
  return getWorkspaceSnapshot(pool, identity.tenantId, identity.role);
});

app.get("/v1/tenants/:tenantId/sources", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  return { data: await listSources(pool, identity.tenantId) };
});

app.get("/v1/tenants/:tenantId/exceptions", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  return { data: await listExceptions(pool, identity.tenantId, request.query) };
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
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin"]);
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
    `SELECT id, period_start, period_end, status, rule_sha256, engine_version, record_highwater,
            idempotency_key, stats, error, started_at, completed_at
       FROM recon_runs WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 100`,
    [identity.tenantId],
  );
  return { data: result.rows };
});

app.get("/v1/tenants/:tenantId/recon-runs/:runId", async (request, reply) => {
  const identity = await requireIdentity(request, reply, ["operator", "reviewer", "admin", "auditor"]);
  if (!identity) return;
  const run = await pool.query(
    `SELECT id, period_start, period_end, status, rule_definition, rule_sha256, engine_version,
            record_highwater, stats, error, started_at, completed_at
       FROM recon_runs WHERE id = $1 AND tenant_id = $2`,
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

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error, requestId: request.requestId }, "request failed");
  if (error.code === "23505") return reply.code(409).send(errorBody("CONFLICT", request.requestId));
  if (["PERIOD_LOCKED", "CLOSE_BLOCKED", "INVALID_PERIOD_STATE"].includes(error.code)) return reply.code(409).send(errorBody(error.code, request.requestId, error.metadata));
  if (["PERIOD_NOT_FOUND"].includes(error.code)) return reply.code(404).send(errorBody(error.code, request.requestId));
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
await app.listen({ host: "127.0.0.1", port: config.port });
