import test from "node:test";
import assert from "node:assert/strict";
import { demoAccounts } from "../src/demo-accounts.mjs";

test("demo identity picker covers every supported role with valid credentials", () => {
  assert.deepEqual(demoAccounts.map((account) => account.role), ["admin", "operator", "reviewer", "auditor"]);
  assert.equal(new Set(demoAccounts.map((account) => account.email)).size, demoAccounts.length);
  assert.ok(demoAccounts.every((account) => account.password.length >= 12));
  assert.ok(demoAccounts.every((account) => account.description.length > 0));
});
