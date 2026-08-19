import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendAudit, withTransaction } from "./database.mjs";
import { parserVersion, preflightCsv } from "./csv.mjs";
import { assertPeriodWritable } from "./close-service.mjs";

export async function importCsv({ pool, objectStorageDir, tenantId, dataSourceId, sourceType, templateVersion = "v1", filename, buffer, actorId, requestId, maxBytes, faultAfterRows = null }) {
  const preflight = preflightCsv(buffer, { sourceType, filename, maxBytes });
  if (!preflight.ok) return { status: "preflight_failed", preflight };
  await assertPeriodWritable(pool, tenantId, preflight.normalizedRecords.map((record) => record.valueDate || record.eventAt?.slice(0, 10)));

  const relativePath = join(tenantId, preflight.sha256.slice(0, 2), `${preflight.sha256}.csv`);
  const finalPath = join(objectStorageDir, relativePath);
  const stagedSuffix = createHash("sha256").update(`${requestId || ""}:${randomUUID()}`).digest("hex").slice(0, 24);
  const stagedPath = `${finalPath}.${stagedSuffix}.part`;
  await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
  await writeFile(stagedPath, buffer, { flag: "wx", mode: 0o600 });
  let publishedByThisRequest = false;

  try {
    const result = await withTransaction(pool, async (client) => {
      const existing = await client.query(
        `SELECT id, status FROM import_batches
          WHERE tenant_id = $1 AND data_source_id = $2 AND sha256 = $3
            AND parser_version = $4 AND template_version = $5`,
        [tenantId, dataSourceId, preflight.sha256, parserVersion, templateVersion],
      );
      if (existing.rowCount) return { batchId: existing.rows[0].id, status: existing.rows[0].status, replayed: true };

      const batch = await client.query(
        `INSERT INTO import_batches
          (tenant_id, data_source_id, sha256, original_filename, byte_size, parser_version, template_version,
           status, encoding, delimiter, row_count, object_path, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10,$11,$12)
         RETURNING id`,
        [tenantId, dataSourceId, preflight.sha256, preflight.filename, preflight.byteSize, parserVersion, templateVersion, preflight.encoding, preflight.delimiter, preflight.rowCount, relativePath, actorId],
      );
      const batchId = batch.rows[0].id;

      for (let index = 0; index < preflight.rawRecords.length; index += 1) {
        if (faultAfterRows !== null && index >= faultAfterRows) throw new Error("Injected import failure");
        const raw = preflight.rawRecords[index];
        const normalized = preflight.normalizedRecords[index];
        const rowHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
        const rawResult = await client.query(
          `INSERT INTO raw_rows (tenant_id, import_batch_id, row_number, row_hash, payload)
           VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
          [tenantId, batchId, index + 2, rowHash, JSON.stringify(raw)],
        );
        await client.query(
          `INSERT INTO canonical_records
            (tenant_id, import_batch_id, raw_row_id, source_type, external_id, record_type, event_at,
             value_date, currency, gross_minor, fee_minor, net_minor, attributes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
          [tenantId, batchId, rawResult.rows[0].id, normalized.sourceType, normalized.externalId, normalized.recordType,
            normalized.eventAt, normalized.valueDate, normalized.currency, normalized.grossMinor?.toString() ?? null,
            normalized.feeMinor?.toString() ?? null, normalized.netMinor.toString(), JSON.stringify(normalized.attributes)],
        );
      }
      await client.query("UPDATE import_batches SET status = 'committed', committed_at = now() WHERE id = $1", [batchId]);
      await appendAudit(client, { tenantId, actorId, action: "import_batch.committed", objectType: "import_batch", objectId: batchId, requestId, metadata: { rowCount: preflight.rowCount, sha256: preflight.sha256, sourceType } });
      try {
        await link(stagedPath, finalPath);
        publishedByThisRequest = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      return { batchId, status: "committed", replayed: false };
    });
    await safeRemove(stagedPath);
    return { ...result, preflight: summarize(preflight) };
  } catch (error) {
    await safeRemove(stagedPath);
    if (publishedByThisRequest) await safeRemove(finalPath);
    if (error.code === "23505") {
      const existing = await pool.query(
        `SELECT id, status FROM import_batches
          WHERE tenant_id = $1 AND data_source_id = $2 AND sha256 = $3
            AND parser_version = $4 AND template_version = $5`,
        [tenantId, dataSourceId, preflight.sha256, parserVersion, templateVersion],
      );
      if (existing.rowCount) return { batchId: existing.rows[0].id, status: existing.rows[0].status, replayed: true, preflight: summarize(preflight) };
    }
    throw error;
  }
}

async function safeRemove(path) {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function summarize(result) {
  return { ok: result.ok, filename: result.filename, sha256: result.sha256, byteSize: result.byteSize, encoding: result.encoding, delimiter: result.delimiter, headers: result.headers, rowCount: result.rowCount, errors: result.errors };
}
