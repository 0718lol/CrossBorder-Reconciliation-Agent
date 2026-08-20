import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPassword } from "./auth.mjs";
import { loadConfig } from "./config.mjs";
import { appendAudit, createDatabase, withTransaction } from "./database.mjs";
import { ensureDemoPeriodArchive } from "./demo-period.mjs";
import { importCsv } from "./import-service.mjs";
import { runReconciliation } from "./recon-service.mjs";
import { demoAccounts } from "./demo-accounts.mjs";

const config = loadConfig();
const pool = createDatabase(config.databaseUrl);
const adminAccount = demoAccounts.find((account) => account.role === "admin");
const requestId = `demo-seed-${randomUUID()}`;

try {
  const setup = await withTransaction(pool, async (client) => {
    const adminPasswordHash = await hashPassword(adminAccount.password);
    let user = await client.query("SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE", [adminAccount.email]);
    if (!user.rowCount) user = await client.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [adminAccount.email, adminPasswordHash]);
    else await client.query("UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1", [user.rows[0].id, adminPasswordHash]);

    const userId = user.rows[0].id;
    let tenant = await client.query(
      `SELECT t.id FROM tenants t JOIN tenant_members tm ON tm.tenant_id = t.id
        WHERE tm.user_id = $1 AND t.name = 'Northstar Commerce Demo' LIMIT 1 FOR UPDATE`,
      [userId],
    );
    if (!tenant.rowCount) tenant = await client.query("INSERT INTO tenants (name) VALUES ('Northstar Commerce Demo') RETURNING id");
    const tenantId = tenant.rows[0].id;
    await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,'admin')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'admin'`,
      [tenantId, userId],
    );
    for (const account of demoAccounts.filter((item) => item.role !== "admin")) {
      const passwordHash = await hashPassword(account.password);
      let demoUser = await client.query("SELECT id FROM users WHERE lower(email) = $1 FOR UPDATE", [account.email]);
      if (!demoUser.rowCount) demoUser = await client.query("INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id", [account.email, passwordHash]);
      else await client.query("UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1", [demoUser.rows[0].id, passwordHash]);
      await client.query(
        `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1,$2,$3::member_role)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [tenantId, demoUser.rows[0].id, account.role],
      );
    }

    const sources = {};
    for (const sourceType of ["shopify", "stripe", "paypal", "wise", "bank"]) {
      const source = await client.query(
        `INSERT INTO data_sources (tenant_id, name, source_type) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, name) DO UPDATE SET source_type = EXCLUDED.source_type RETURNING id`,
        [tenantId, `${sourceType}-demo`, sourceType],
      );
      sources[sourceType] = source.rows[0].id;
    }
    await appendAudit(client, {
      tenantId,
      actorId: userId,
      action: "demo.seeded",
      objectType: "tenant",
      objectId: tenantId,
      requestId,
      metadata: { fictional: true, currencies: ["USD", "EUR", "GBP"] },
    });
    return { tenantId, userId, sources };
  });

  for (const [sourceType, filename] of [
    ["shopify", "demo_shopify_orders.csv"],
    ["stripe", "demo_stripe_transactions.csv"],
    ["bank", "demo_bank_statement.csv"],
    ["paypal", "paypal_transactions.csv"],
    ["wise", "wise_balance_statement.csv"],
  ]) {
    await importCsv({
      pool,
      objectStorageDir: config.objectStorageDir,
      tenantId: setup.tenantId,
      dataSourceId: setup.sources[sourceType],
      sourceType,
      filename,
      buffer: await readFile(join(import.meta.dirname, "..", "fixtures", filename)),
      actorId: setup.userId,
      requestId: `${requestId}-${sourceType}`,
      maxBytes: config.maxUploadBytes,
    });
  }

  const orderRun = await runReconciliation({
    pool, tenantId: setup.tenantId, actorId: setup.userId, requestId,
    idempotencyKey: "demo-order-to-charge-v1", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    rule: {
      sourceTypes: ["shopify"], targetTypes: ["stripe"], sourceRecordTypes: ["order_paid"], targetRecordTypes: ["charge"],
      sourceAmountField: "gross_minor", targetAmountField: "gross_minor", dateWindowDays: 7,
    },
  });
  const payoutRun = await runReconciliation({
    pool, tenantId: setup.tenantId, actorId: setup.userId, requestId,
    idempotencyKey: "demo-payout-to-bank-v1", periodStart: "2026-08-01", periodEnd: "2026-08-31",
    rule: {
      sourceTypes: ["stripe"], targetTypes: ["bank"], sourceRecordTypes: ["payout"], targetRecordTypes: ["credit"],
      sourceAmountField: "net_minor", targetAmountField: "net_minor", sourceAbsolute: true, dateWindowDays: 3,
    },
  });
  const periods = await ensureDemoPeriodArchive({
    pool, tenantId: setup.tenantId, actorId: setup.userId, requestId, runId: payoutRun.runId,
  });

  process.stdout.write(`${JSON.stringify({
    tenantId: setup.tenantId, tenantName: "Northstar Commerce Demo", accounts: demoAccounts.map(({ email, role }) => ({ email, role })),
    runs: [orderRun.runId, payoutRun.runId], periods,
  }, null, 2)}\n`);
} finally {
  await pool.end();
}
