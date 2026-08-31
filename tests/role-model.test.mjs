import test from "node:test";
import assert from "node:assert/strict";
import { can, canRead, canView, getRoleProfile } from "../public/console/role-model.js";

test("role workspaces expose distinct, least-privilege navigation", () => {
  assert.deepEqual(getRoleProfile("admin").views, ["overview", "sources", "runs", "exceptions", "periods", "audit"]);
  assert.equal(getRoleProfile("admin").navigation.exceptions, "异常与调查建议");
  assert.deepEqual(getRoleProfile("operator").views, ["overview", "sources", "runs", "exceptions"]);
  assert.deepEqual(getRoleProfile("reviewer").views, ["overview", "runs", "exceptions", "periods"]);
  assert.deepEqual(getRoleProfile("auditor").views, ["overview", "runs", "periods", "audit"]);
});

test("role workspaces align optional reads and mutation controls", () => {
  const operator = getRoleProfile("operator");
  assert.equal(can(operator, "upload"), true);
  assert.equal(can(operator, "run"), true);
  assert.equal(can(operator, "exception_claim"), true);
  assert.equal(can(operator, "exception_submit"), true);
  assert.equal(can(operator, "ai_suggest"), true);
  assert.equal(can(operator, "exception_review"), false);
  assert.equal(canRead(operator, "periods"), false);
  assert.equal(canView(operator, "audit"), false);

  const reviewer = getRoleProfile("reviewer");
  assert.equal(can(reviewer, "upload"), false);
  assert.equal(can(reviewer, "run"), false);
  assert.equal(can(reviewer, "period_close"), true);
  assert.equal(can(reviewer, "exception_review"), true);
  assert.equal(can(reviewer, "exception_submit"), false);
  assert.equal(can(reviewer, "ai_suggest"), true);
  assert.equal(canRead(reviewer, "audit"), false);

  const auditor = getRoleProfile("auditor");
  assert.equal(can(auditor, "upload"), false);
  assert.equal(can(auditor, "period_close"), false);
  assert.equal(can(auditor, "ai_suggest"), false);
  assert.equal(canRead(auditor, "periods"), true);
  assert.equal(canRead(auditor, "audit"), true);
});

test("unknown roles fail closed", () => {
  const unknown = getRoleProfile("unexpected-role");
  assert.deepEqual(unknown.views, ["overview"]);
  assert.deepEqual(unknown.capabilities, []);
  assert.deepEqual(unknown.reads, []);
});
