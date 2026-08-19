import test from "node:test";
import assert from "node:assert/strict";
import { matchRecords, MatchingBudgetExceeded } from "../src/matching.mjs";

const record = (id, amountMinor, businessDate = "2026-08-10", currency = "USD", attributes = {}) => ({ id, amountMinor: BigInt(amountMinor), businessDate, currency, attributes });

test("matches a unique one-to-one amount deterministically", () => {
  const result = matchRecords({ sources: [record("s1", 100)], targets: [record("t1", 100)] });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].type, "one_to_one");
  assert.equal(result.groups[0].amountMinor, 100n);
  assert.equal(result.unmatchedSources.length, 0);
});

test("supports unique many-to-one and one-to-many combinations", () => {
  const manyToOne = matchRecords({ sources: [record("s1", 30), record("s2", 70)], targets: [record("t1", 100)] });
  assert.equal(manyToOne.groups[0].type, "many_to_one");
  assert.equal(manyToOne.groups[0].allocations.length, 3);

  const oneToMany = matchRecords({ sources: [record("s1", 100)], targets: [record("t1", 25), record("t2", 75)] });
  assert.equal(oneToMany.groups[0].type, "one_to_many");
  assert.equal(oneToMany.groups[0].allocations.length, 3);
});

test("does not auto-select ambiguous exact or combination candidates", () => {
  const exact = matchRecords({ sources: [record("s1", 100)], targets: [record("t1", 100), record("t2", 100)] });
  assert.equal(exact.groups.length, 0);
  assert.equal(exact.issues[0].type, "ambiguous_exact");

  const combination = matchRecords({ sources: [record("s1", 20), record("s2", 30), record("s3", 20), record("s4", 30)], targets: [record("t1", 50)] });
  assert.equal(combination.groups.length, 0);
  assert.equal(combination.issues.some((item) => item.type === "ambiguous_combination"), true);
});

test("strong identifiers disambiguate equal amounts", () => {
  const source = record("s1", 100, "2026-08-10", "USD", { reference: "A" });
  const targets = [record("t1", 100, "2026-08-10", "USD", { reference: "B" }), record("t2", 100, "2026-08-10", "USD", { reference: "A" })];
  const result = matchRecords({ sources: [source], targets, identifierPairs: [{ source: "attributes.reference", target: "attributes.reference" }] });
  assert.equal(result.groups[0].allocations.find((item) => item.role === "target").recordId, "t2");
});

test("explicit identifiers never fall back to an amount-only match", () => {
  const source = record("s1", 100, "2026-08-10", "USD", { reference: "A" });
  const target = record("t1", 100, "2026-08-10", "USD", { reference: "B" });
  const result = matchRecords({ sources: [source], targets: [target], identifierPairs: [{ source: "attributes.reference", target: "attributes.reference" }] });
  assert.equal(result.groups.length, 0);
  assert.equal(result.unmatchedSources[0].remainingMinor, 100n);
});

test("enforces currency/date boundaries and preserves unmatched balances", () => {
  const result = matchRecords({ sources: [record("s1", 100, "2026-08-01", "USD")], targets: [record("t1", 100, "2026-08-20", "USD"), record("t2", 100, "2026-08-01", "EUR")], dateWindowDays: 7 });
  assert.equal(result.groups.length, 0);
  assert.equal(result.unmatchedSources[0].remainingMinor, 100n);
});

test("partial matching never over-allocates and reports residuals", () => {
  const result = matchRecords({ sources: [record("s1", 100)], targets: [record("t1", 60)], allowPartial: true });
  assert.equal(result.groups[0].type, "partial");
  assert.equal(result.groups[0].amountMinor, 60n);
  assert.equal(result.unmatchedSources[0].remainingMinor, 40n);
  assert.equal(result.unmatchedTargets.length, 0);
});

test("candidate and time budgets fail closed", () => {
  const candidates = Array.from({ length: 4 }, (_, index) => record(`s${index}`, 10));
  const limited = matchRecords({ sources: candidates, targets: [record("t1", 40)], maxCandidates: 2 });
  assert.equal(limited.groups.length, 0);
  assert.equal(limited.issues.some((item) => item.type === "candidate_limit"), true);
  assert.throws(() => matchRecords({ sources: candidates, targets: [record("t1", 40)], timeBudgetMs: 0 }), /timeBudgetMs/);
  assert.equal(new MatchingBudgetExceeded().code, "MATCHING_BUDGET_EXCEEDED");
});

test("same input produces the same allocation order", () => {
  const input = { sources: [record("s2", 40, "2026-08-02"), record("s1", 60, "2026-08-01")], targets: [record("t1", 100, "2026-08-03")] };
  const serialize = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
  const expected = serialize(matchRecords(input).groups);
  for (let attempt = 0; attempt < 25; attempt += 1) assert.equal(serialize(matchRecords(input).groups), expected);
});
