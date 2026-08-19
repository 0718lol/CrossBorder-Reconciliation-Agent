import { performance } from "node:perf_hooks";

export class MatchingBudgetExceeded extends Error {
  constructor(message = "Matching time budget exceeded") {
    super(message);
    this.code = "MATCHING_BUDGET_EXCEEDED";
  }
}

export function matchRecords({ sources, targets, dateWindowDays = 7, maxCandidates = 20, maxCombinationSize = 5, timeBudgetMs = 1000, allowPartial = false, identifierPairs = [] }) {
  validateOptions({ dateWindowDays, maxCandidates, maxCombinationSize, timeBudgetMs });
  const startedAt = performance.now();
  const deadline = startedAt + timeBudgetMs;
  const sourceState = prepare(sources, "source");
  const targetState = prepare(targets, "target");
  const groups = [];
  const issues = [];

  const assertBudget = () => {
    if (performance.now() > deadline) throw new MatchingBudgetExceeded();
  };

  // Strong identifiers take precedence. Amount-only matching is automatic only when unique.
  for (const source of sourceState) {
    assertBudget();
    if (source.remaining === 0n) continue;
    const exact = compatible(source, targetState, dateWindowDays)
      .filter((target) => target.remaining === source.remaining);
    const strong = exact.filter((target) => identifiersMatch(source.record, target.record, identifierPairs));
    const candidates = identifierPairs.length ? strong : exact;
    if (candidates.length === 1) allocate(groups, "one_to_one", [source], [candidates[0]], source.remaining, "exact");
    else if (candidates.length > 1) issues.push(issue("ambiguous_exact", source, candidates));
  }

  // Many source records can settle into one target record.
  for (const target of targetState) {
    assertBudget();
    if (target.remaining === 0n) continue;
    const candidates = compatible(target, sourceState, dateWindowDays)
      .filter((source) => source.remaining > 0n && source.remaining < target.remaining)
      .filter((source) => !identifierPairs.length || identifiersMatch(source.record, target.record, identifierPairs));
    if (candidates.length > maxCandidates) {
      issues.push(issue("candidate_limit", target, candidates));
      continue;
    }
    const result = uniqueSubset(candidates, target.remaining, maxCombinationSize, assertBudget);
    if (result.kind === "unique") allocateMany(groups, "many_to_one", result.items, [target]);
    else if (result.kind === "ambiguous") issues.push(issue("ambiguous_combination", target, candidates));
  }

  // One source record can be paid by several target records.
  for (const source of sourceState) {
    assertBudget();
    if (source.remaining === 0n) continue;
    const candidates = compatible(source, targetState, dateWindowDays)
      .filter((target) => target.remaining > 0n && target.remaining < source.remaining)
      .filter((target) => !identifierPairs.length || identifiersMatch(source.record, target.record, identifierPairs));
    if (candidates.length > maxCandidates) {
      issues.push(issue("candidate_limit", source, candidates));
      continue;
    }
    const result = uniqueSubset(candidates, source.remaining, maxCombinationSize, assertBudget);
    if (result.kind === "unique") allocateMany(groups, "one_to_many", [source], result.items);
    else if (result.kind === "ambiguous") issues.push(issue("ambiguous_combination", source, candidates));
  }

  // Partial allocation is conservative: only one compatible counterparty may remain.
  if (allowPartial) {
    for (const source of sourceState) {
      assertBudget();
      if (source.remaining === 0n) continue;
      const candidates = compatible(source, targetState, dateWindowDays)
        .filter((target) => target.remaining > 0n)
        .filter((target) => !identifierPairs.length || identifiersMatch(source.record, target.record, identifierPairs));
      if (candidates.length === 1) {
        const amount = min(source.remaining, candidates[0].remaining);
        allocate(groups, "partial", [source], [candidates[0]], amount, "unique_partial");
      } else if (candidates.length > 1) {
        issues.push(issue("ambiguous_partial", source, candidates));
      }
    }
  }

  const unmatchedSources = sourceState.filter((item) => item.remaining > 0n).map(publicRemainder);
  const unmatchedTargets = targetState.filter((item) => item.remaining > 0n).map(publicRemainder);
  return {
    groups,
    unmatchedSources,
    unmatchedTargets,
    issues: dedupeIssues(issues),
    stats: {
      sourceCount: sourceState.length,
      targetCount: targetState.length,
      groupCount: groups.length,
      matchedSourceMinor: sum(sourceState.map((item) => item.amount - item.remaining)),
      matchedTargetMinor: sum(targetState.map((item) => item.amount - item.remaining)),
      elapsedMs: performance.now() - startedAt,
    },
  };
}

function prepare(records, role) {
  const ids = new Set();
  return records.map((record) => {
    if (!record?.id || ids.has(record.id)) throw new Error(`Duplicate or missing ${role} record id`);
    ids.add(record.id);
    const amount = BigInt(record.amountMinor);
    if (amount <= 0n) throw new Error(`${role} amount must be positive`);
    const currency = String(record.currency || "").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${role} currency is invalid`);
    const businessDate = normalizeDay(record.businessDate);
    return { record, id: String(record.id), currency, businessDate, amount, remaining: amount, role };
  }).sort(compareState);
}

function compatible(item, candidates, dateWindowDays) {
  return candidates.filter((candidate) => candidate.currency === item.currency && dayDistance(candidate.businessDate, item.businessDate) <= dateWindowDays);
}

function identifiersMatch(source, target, pairs) {
  if (!pairs.length) return false;
  return pairs.every(({ source: sourceField, target: targetField }) => {
    const left = fieldValue(source, sourceField);
    const right = fieldValue(target, targetField);
    return left !== "" && right !== "" && left === right;
  });
}

function fieldValue(record, path) {
  const value = String(path || "").split(".").reduce((current, key) => current?.[key], record);
  return value === undefined || value === null ? "" : String(value).trim();
}

function uniqueSubset(candidates, target, maxSize, assertBudget) {
  const ordered = [...candidates].sort(compareState);
  const solutions = [];
  function visit(start, selected, total) {
    assertBudget();
    if (total === target && selected.length >= 2) {
      solutions.push([...selected]);
      return;
    }
    if (total >= target || selected.length >= maxSize || solutions.length > 1) return;
    for (let index = start; index < ordered.length; index += 1) {
      const item = ordered[index];
      if (total + item.remaining > target) continue;
      selected.push(item);
      visit(index + 1, selected, total + item.remaining);
      selected.pop();
      if (solutions.length > 1) return;
    }
  }
  visit(0, [], 0n);
  if (solutions.length === 1) return { kind: "unique", items: solutions[0] };
  if (solutions.length > 1) return { kind: "ambiguous" };
  return { kind: "none" };
}

function allocateMany(groups, type, sources, targets) {
  const sourceTotal = sum(sources.map((item) => item.remaining));
  const targetTotal = sum(targets.map((item) => item.remaining));
  if (sourceTotal !== targetTotal) throw new Error("Combination allocation is not balanced");
  const sourceAllocations = sources.map((item) => ({ item, amount: item.remaining }));
  const targetAllocations = targets.map((item) => ({ item, amount: item.remaining }));
  allocateGroup(groups, type, sourceAllocations, targetAllocations, "unique_subset");
}

function allocate(groups, type, sources, targets, amount, evidence) {
  allocateGroup(
    groups,
    type,
    sources.map((item) => ({ item, amount })),
    targets.map((item) => ({ item, amount })),
    evidence,
  );
}

function allocateGroup(groups, type, sources, targets, evidence) {
  const sourceTotal = sum(sources.map(({ amount }) => amount));
  const targetTotal = sum(targets.map(({ amount }) => amount));
  if (sourceTotal !== targetTotal || sourceTotal <= 0n) throw new Error("Match group must conserve a positive amount");
  for (const allocation of [...sources, ...targets]) {
    if (allocation.amount <= 0n || allocation.amount > allocation.item.remaining) throw new Error("Allocation exceeds available amount");
    allocation.item.remaining -= allocation.amount;
  }
  groups.push({
    type,
    currency: sources[0].item.currency,
    amountMinor: sourceTotal,
    evidence,
    allocations: [
      ...sources.map(({ item, amount }) => ({ recordId: item.id, role: "source", allocatedMinor: amount })),
      ...targets.map(({ item, amount }) => ({ recordId: item.id, role: "target", allocatedMinor: amount })),
    ],
  });
}

function issue(type, record, candidates) {
  return { type, recordId: record.id, role: record.role, candidateIds: candidates.slice(0, 20).map((item) => item.id) };
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((item) => {
    const key = `${item.type}:${item.role}:${item.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function publicRemainder(item) { return { recordId: item.id, role: item.role, currency: item.currency, remainingMinor: item.remaining }; }
function sum(values) { return values.reduce((total, value) => total + value, 0n); }
function min(left, right) { return left < right ? left : right; }
function compareState(left, right) { return left.businessDate.localeCompare(right.businessDate) || left.id.localeCompare(right.id); }
function normalizeDay(value) { const day = String(value || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error("businessDate must be YYYY-MM-DD"); return day; }
function dayDistance(left, right) { return Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000; }
function validateOptions({ dateWindowDays, maxCandidates, maxCombinationSize, timeBudgetMs }) {
  if (!Number.isInteger(dateWindowDays) || dateWindowDays < 0 || dateWindowDays > 366) throw new Error("dateWindowDays is out of range");
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) throw new Error("maxCandidates is out of range");
  if (!Number.isInteger(maxCombinationSize) || maxCombinationSize < 2 || maxCombinationSize > 10) throw new Error("maxCombinationSize is out of range");
  if (!Number.isInteger(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 30_000) throw new Error("timeBudgetMs is out of range");
}
