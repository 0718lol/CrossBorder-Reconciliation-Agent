import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDecimalMinor, preflightCsv } from "../src/csv.mjs";

const fixture = (name) => readFile(join(import.meta.dirname, "..", "fixtures", name));

test("officially-derived fictional fixtures pass preflight", async () => {
  const cases = [["stripe_balance_transactions.csv", "stripe", 4], ["paypal_transactions.csv", "paypal", 3], ["wise_balance_statement.csv", "wise", 3], ["bank_statement.csv", "bank", 2], ["shopify_orders.csv", "shopify", 2]];
  for (const [name, sourceType, rows] of cases) {
    const result = preflightCsv(await fixture(name), { sourceType, filename: name });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.rowCount, rows);
    assert.equal(result.normalizedRecords.length, rows);
  }
});

test("decimal amounts are exact and reject excess precision", () => {
  assert.equal(parseDecimalMinor("8340.80"), 834080n);
  assert.equal(parseDecimalMinor("-0.01"), -1n);
  assert.throws(() => parseDecimalMinor("1.001"), /two decimal/);
});

test("a bad late row rejects the complete batch and publishes no normalized rows", () => {
  const csv = Buffer.from("transaction_id,value_date,direction,amount,currency\nB1,2026-08-01,credit,1.00,USD\nB2,2026-08-02,credit,broken,USD\n");
  const result = preflightCsv(csv, { sourceType: "bank" });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].row, 3);
  assert.deepEqual(result.normalizedRecords, []);
});

test("missing currency, unknown currency, duplicate headers and empty files fail", () => {
  assert.equal(preflightCsv(Buffer.alloc(0), { sourceType: "bank" }).errors[0].code, "EMPTY_FILE");
  const missing = preflightCsv(Buffer.from("transaction_id,value_date,direction,amount,currency\nB1,2026-08-01,credit,1.00,\n"), { sourceType: "bank" });
  assert.equal(missing.errors[0].code, "MISSING_FIELD");
  const unknown = preflightCsv(Buffer.from("transaction_id,value_date,direction,amount,currency\nB1,2026-08-01,credit,1.00,JPY\n"), { sourceType: "bank" });
  assert.equal(unknown.errors[0].code, "UNSUPPORTED_CURRENCY");
  const duplicate = preflightCsv(Buffer.from("id,id\n1,2\n"), { sourceType: "bank" });
  assert.equal(duplicate.ok, false);
});

test("Stripe amount invariant is enforced", () => {
  const csv = Buffer.from("id,amount,fee,net,currency,created,available_on,reporting_category\ntxn_bad,100,3,98,usd,1785686400,1785686400,charge\n");
  const result = preflightCsv(csv, { sourceType: "stripe" });
  assert.equal(result.errors[0].code, "AMOUNT_INVARIANT");
});
