import pg from "pg";

const { Pool } = pg;

// PostgreSQL DATE has no timezone. Keep it as YYYY-MM-DD instead of creating a
// local-midnight Date that shifts when serialized to UTC.
pg.types.setTypeParser(1082, (value) => value);

export function createDatabase(databaseUrl) {
  return new Pool({ connectionString: databaseUrl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendAudit(client, { tenantId = null, actorId = null, action, objectType, objectId, requestId = null, reason = null, metadata = {} }) {
  await client.query(
    `INSERT INTO audit_events (tenant_id, actor_id, action, object_type, object_id, request_id, reason, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [tenantId, actorId, action, objectType, String(objectId), requestId, reason, JSON.stringify(metadata)],
  );
}

export async function authorizeRequest(pool, tokenHash, tenantId, allowedRoles) {
  const result = await pool.query(
    `SELECT s.user_id, tm.role
       FROM sessions s
       JOIN tenant_members tm ON tm.user_id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND tm.tenant_id = $2`,
    [tokenHash, tenantId],
  );
  const identity = result.rows[0];
  if (!identity || !allowedRoles.includes(identity.role)) return null;
  return { userId: identity.user_id, role: identity.role, tenantId };
}

export async function authenticateSession(pool, tokenHash) {
  const result = await pool.query(
    `SELECT user_id FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0]?.user_id || null;
}
