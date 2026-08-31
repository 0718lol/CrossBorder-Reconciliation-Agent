import { appendAudit, withTransaction } from "./database.mjs";
import { issueSessionToken, validateEmail, verifyPassword } from "./auth.mjs";

export async function createSessionForCredentials({
  pool,
  email: rawEmail,
  password,
  tenantId,
  dummyPasswordHash,
  sessionTtlSeconds,
  requestId,
}) {
  let email;
  try { email = validateEmail(rawEmail); }
  catch { throw codedError("INVALID_CREDENTIALS"); }

  const userResult = await pool.query(
    "SELECT id, password_hash FROM users WHERE lower(email) = $1 AND status = 'active'",
    [email],
  );
  const user = userResult.rows[0];
  const passwordMatches = await verifyPassword(password, user?.password_hash || dummyPasswordHash);
  if (!user || !passwordMatches) throw codedError("INVALID_CREDENTIALS");

  const memberships = await pool.query(
    `SELECT tm.tenant_id, tm.role, t.name AS tenant_name
       FROM tenant_members tm
       JOIN tenants t ON t.id = tm.tenant_id
      WHERE tm.user_id = $1 AND t.status = 'active'
      ORDER BY lower(t.name), tm.tenant_id`,
    [user.id],
  );
  const requestedTenantId = typeof tenantId === "string" ? tenantId : null;
  const membership = requestedTenantId
    ? memberships.rows.find((item) => item.tenant_id === requestedTenantId)
    : memberships.rows.length === 1 ? memberships.rows[0] : null;

  if (!membership && !requestedTenantId && memberships.rows.length > 1) {
    throw codedError("WORKSPACE_REQUIRED", {
      workspaces: memberships.rows.map((item) => ({
        tenantId: item.tenant_id,
        tenantName: item.tenant_name,
        role: item.role,
      })),
    });
  }
  if (!membership) throw codedError("INVALID_CREDENTIALS");

  const { token, tokenHash } = issueSessionToken();
  const expiresAt = new Date(Date.now() + sessionTtlSeconds * 1000);
  await withTransaction(pool, async (client) => {
    await client.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1,$2,$3)",
      [user.id, tokenHash, expiresAt],
    );
    await appendAudit(client, {
      tenantId: membership.tenant_id,
      actorId: user.id,
      action: "session.created",
      objectType: "user",
      objectId: user.id,
      requestId,
    });
  });

  return {
    token,
    userId: user.id,
    expiresAt: expiresAt.toISOString(),
    role: membership.role,
    tenantId: membership.tenant_id,
    tenantName: membership.tenant_name,
  };
}

function codedError(code, metadata = {}) {
  return Object.assign(new Error(code), { code, metadata });
}
