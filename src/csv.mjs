import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

export const parserVersion = "foundation-csv-v1";

export function preflightCsv(buffer, { sourceType, filename = "upload.csv", maxBytes = 10 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error("CSV input must be a Buffer");
  if (buffer.length === 0) return failed("EMPTY_FILE", "CSV file is empty");
  if (buffer.length > maxBytes) return failed("FILE_TOO_LARGE", `CSV exceeds ${maxBytes} bytes`);
  const decoded = decodeBuffer(buffer);
  let delimiter;
  let records;
  try {
    delimiter = detectDelimiter(decoded.text);
    const headerRows = parse(decoded.text, { bom: true, delimiter, to_line: 1, relax_column_count: false, skip_empty_lines: true, trim: true });
    const headers = headerRows[0] || [];
    if (!headers.length || headers.some((header) => !header.trim())) return failed("INVALID_HEADER", "CSV contains an empty header");
    if (new Set(headers).size !== headers.length) return failed("DUPLICATE_HEADER", "CSV contains duplicate headers");
    records = parse(decoded.text, {
      bom: true,
      columns: headers,
      from_line: 2,
      delimiter,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (error) {
    return failed("MALFORMED_CSV", sanitizeMessage(error.message));
  }
  if (!records.length) return failed("NO_DATA_ROWS", "CSV contains a header but no data rows");
  const headers = Object.keys(records[0]);

  const errors = [];
  const normalized = [];
  for (let index = 0; index < records.length; index += 1) {
    try {
      normalized.push(normalizeRecord(sourceType, records[index], index + 2));
    } catch (error) {
      errors.push({ row: index + 2, code: error.code || "INVALID_ROW", message: sanitizeMessage(error.message) });
    }
  }
  return {
    ok: errors.length === 0,
    filename: sanitizeFilename(filename),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    byteSize: buffer.length,
    encoding: decoded.encoding,
    delimiter,
    headers,
    rowCount: records.length,
    errors,
    rawRecords: records,
    normalizedRecords: errors.length ? [] : normalized,
  };
}

export function normalizeRecord(sourceType, record, rowNumber) {
  switch (sourceType) {
    case "stripe": return normalizeStripe(record, rowNumber);
    case "paypal": return normalizePaypal(record, rowNumber);
    case "wise":
    case "bank": return normalizeBank(record, rowNumber, sourceType);
    case "shopify": return normalizeShopify(record, rowNumber);
    default: throw rowError("UNSUPPORTED_SOURCE", `Unsupported source type: ${sourceType}`, rowNumber);
  }
}

function normalizeStripe(row, line) {
  required(row, ["id", "amount", "fee", "net", "currency", "created", "available_on", "reporting_category"], line);
  const gross = parseIntegerMinor(row.amount, "amount", line);
  const fee = parseIntegerMinor(row.fee, "fee", line);
  const net = parseIntegerMinor(row.net, "net", line);
  if (gross - fee !== net) throw rowError("AMOUNT_INVARIANT", "Stripe amount - fee must equal net", line);
  return canonical({ sourceType: "stripe", externalId: row.id, recordType: row.reporting_category, eventAt: unixDate(row.created, line), valueDate: unixDay(row.available_on, line), currency: row.currency, gross, fee, net, attributes: row });
}

function normalizePaypal(row, line) {
  required(row, ["transaction_id", "transaction_event_code", "transaction_initiation_date", "transaction_amount", "transaction_currency", "fee_amount", "fee_currency", "transaction_status"], line);
  const currency = normalizeCurrency(row.transaction_currency, line);
  if (normalizeCurrency(row.fee_currency, line) !== currency) throw rowError("CURRENCY_MISMATCH", "PayPal transaction and fee currencies differ", line);
  const gross = parseDecimalMinor(row.transaction_amount, "transaction_amount", line);
  const feeSigned = parseDecimalMinor(row.fee_amount, "fee_amount", line);
  const net = gross + feeSigned;
  return canonical({ sourceType: "paypal", externalId: row.transaction_id, recordType: paypalRecordType(row.transaction_event_code), eventAt: isoDate(row.transaction_initiation_date, line), valueDate: null, currency, gross, fee: feeSigned < 0n ? -feeSigned : feeSigned, net, attributes: row });
}

function normalizeBank(row, line, sourceType) {
  required(row, ["transaction_id", "value_date", "direction", "amount", "currency"], line);
  if (!new Set(["credit", "debit"]).has(row.direction)) throw rowError("INVALID_DIRECTION", "direction must be credit or debit", line);
  const unsigned = parseDecimalMinor(row.amount, "amount", line);
  if (unsigned < 0n) throw rowError("NEGATIVE_BANK_AMOUNT", "bank amount must be non-negative; use direction", line);
  const net = row.direction === "debit" ? -unsigned : unsigned;
  return canonical({ sourceType, externalId: row.transaction_id, recordType: row.direction, eventAt: null, valueDate: isoDay(row.value_date, line), currency: row.currency, gross: net, fee: 0n, net, attributes: row });
}

function normalizeShopify(row, line) {
  required(row, ["order_id", "processed_at", "financial_status", "currency", "total_price"], line);
  const gross = parseDecimalMinor(row.total_price, "total_price", line);
  return canonical({ sourceType: "shopify", externalId: row.order_id, recordType: `order_${row.financial_status}`, eventAt: isoDate(row.processed_at, line), valueDate: null, currency: row.currency, gross, fee: 0n, net: gross, attributes: row });
}

function canonical({ sourceType, externalId, recordType, eventAt, valueDate, currency, gross, fee, net, attributes }) {
  return { sourceType, externalId: String(externalId), recordType, eventAt, valueDate, currency: normalizeCurrency(currency), grossMinor: gross, feeMinor: fee, netMinor: net, attributes };
}

export function parseDecimalMinor(value, field = "amount", line = 0) {
  const match = String(value ?? "").trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw rowError("INVALID_AMOUNT", `${field} must have at most two decimal places`, line);
  const amount = BigInt(match[2]) * 100n + BigInt((match[3] || "").padEnd(2, "0"));
  return match[1] ? -amount : amount;
}

function parseIntegerMinor(value, field, line) {
  if (!/^-?\d+$/.test(String(value ?? "").trim())) throw rowError("INVALID_MINOR_AMOUNT", `${field} must be an integer minor-unit amount`, line);
  return BigInt(value);
}

function required(row, fields, line) {
  for (const field of fields) if (row[field] === undefined || String(row[field]).trim() === "") throw rowError("MISSING_FIELD", `Missing required field: ${field}`, line);
}

function normalizeCurrency(value, line = 0) {
  const currency = String(value || "").trim().toUpperCase();
  if (!new Set(["USD", "EUR", "GBP", "HKD"]).has(currency)) throw rowError("UNSUPPORTED_CURRENCY", `Unsupported currency: ${currency || "missing"}`, line);
  return currency;
}

function paypalRecordType(code) {
  if (code === "T1107") return "refund";
  if (code.startsWith("T04")) return "bank_transfer";
  return "payment";
}

function decodeBuffer(buffer) {
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "UTF-8" }; }
  catch { return { text: new TextDecoder("gb18030", { fatal: true }).decode(buffer), encoding: "GB18030" }; }
}

function detectDelimiter(text) {
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0];
  const candidates = [",", "\t", ";", "|"];
  const counts = candidates.map((candidate) => ({ candidate, count: line.split(candidate).length - 1 })).sort((a, b) => b.count - a.count);
  if (!counts[0].count) throw Object.assign(new Error("Unable to detect CSV delimiter"), { code: "UNKNOWN_DELIMITER" });
  return counts[0].candidate;
}

function unixDate(value, line) { const date = new Date(Number(value) * 1000); if (Number.isNaN(date.valueOf())) throw rowError("INVALID_DATE", `Invalid Unix timestamp: ${value}`, line); return date.toISOString(); }
function unixDay(value, line) { return unixDate(value, line).slice(0, 10); }
function isoDate(value, line) { const date = new Date(value); if (Number.isNaN(date.valueOf())) throw rowError("INVALID_DATE", `Invalid date: ${value}`, line); return date.toISOString(); }
function isoDay(value, line) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw rowError("INVALID_DATE", `Invalid date: ${value}`, line); return value; }
function sanitizeFilename(value) { return String(value).replace(/[\\/\0]/g, "_").slice(0, 255) || "upload.csv"; }
function sanitizeMessage(value) { return String(value).replace(/[\r\n\t]+/g, " ").slice(0, 300); }
function failed(code, message) { return { ok: false, errors: [{ row: null, code, message }], normalizedRecords: [], rawRecords: [] }; }
function rowError(code, message, row) { return Object.assign(new Error(message), { code, row }); }
