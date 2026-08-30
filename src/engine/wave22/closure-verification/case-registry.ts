export const wave22ClosureCaseIds = Object.freeze({
  crash: Object.freeze([
    "SECURITY_CRASH_001_AFTER_RECEIVED",
    "SECURITY_CRASH_002_AFTER_PRIVATE_COPY",
    "SECURITY_CRASH_003_AFTER_VALIDATION",
    "SECURITY_CRASH_004_AFTER_ARTIFACT_PUBLISH",
    "SECURITY_CRASH_005_AFTER_EVENT_PUBLISH",
    "SECURITY_CRASH_006_AFTER_LEDGER_APPEND",
    "SECURITY_CRASH_007_AFTER_COMMIT_MARKER",
  ]),
  corruption: Object.freeze([
    "SECURITY_CORRUPTION_001_JOURNAL",
    "SECURITY_CORRUPTION_002_EVENT",
    "SECURITY_CORRUPTION_003_LEDGER",
    "SECURITY_CORRUPTION_004_COMMIT_MARKER",
  ]),
  multi_process: Object.freeze([
    "SECURITY_MULTIPROCESS_001_IDENTICAL_CONCURRENT",
    "SECURITY_MULTIPROCESS_002_DIFFERENT_BYTES_ONE_IDENTITY",
    "SECURITY_MULTIPROCESS_003_IDENTICAL_BYTES_CONFLICTING_IDENTITY",
    "SECURITY_MULTIPROCESS_004_STALE_LOCK",
    "SECURITY_MULTIPROCESS_005_PID_REUSE_POISON",
    "SECURITY_MULTIPROCESS_006_RESTART_HOLDING_LOCK",
  ]),
  reader_race: Object.freeze(["SECURITY_READER_RACE_001_PUBLICATION"]),
  rule_input: Object.freeze([
    "RULE_INPUT_NEG_001_MISSING",
    "RULE_INPUT_NEG_002_CONFLICTED",
    "RULE_INPUT_NEG_003_UNCONFIRMED",
    "RULE_INPUT_NEG_004_STALE",
    "RULE_INPUT_NEG_005_LOW_CONFIDENCE",
  ]),
  ground_truth: Object.freeze([
    "GT_NEG_001_DISTINCT_ANNOTATORS",
    "GT_NEG_002_EMPTY_TEMPLATE",
    "GT_NEG_003_MISSING_EVIDENCE",
    "GT_NEG_004_HASH_MISMATCH",
    "GT_NEG_005_INVALID_GEOMETRY",
  ]),
});

export const wave22ClosureExpectedCaseCounts = Object.freeze(
  Object.fromEntries(Object.entries(wave22ClosureCaseIds).map(([group, ids]) => [group, ids.length])),
);

export type RawClosureCase = Readonly<{ case_id: string; passed: boolean }>;

export function validateWave22RawCaseMatrices(matrices: Readonly<Record<string, readonly RawClosureCase[]>>) {
  const groups = Object.keys(wave22ClosureCaseIds).sort();
  if (Object.keys(matrices).sort().join("\n") !== groups.join("\n")) {
    throw new Error("wave22_raw_matrix_groups_mismatch");
  }
  const observedIds = new Set<string>();
  for (const group of groups) {
    const expected = wave22ClosureCaseIds[group as keyof typeof wave22ClosureCaseIds];
    const observed = matrices[group];
    if (observed.length !== expected.length) throw new Error(`wave22_raw_matrix_count_mismatch:${group}`);
    for (let index = 0; index < expected.length; index += 1) {
      const item = observed[index];
      if (item.case_id !== expected[index]) throw new Error(`wave22_raw_matrix_id_mismatch:${group}:${index}`);
      if (!item.passed) throw new Error(`wave22_raw_matrix_case_failed:${item.case_id}`);
      if (observedIds.has(item.case_id)) throw new Error(`wave22_raw_matrix_duplicate_case:${item.case_id}`);
      observedIds.add(item.case_id);
    }
  }
  return Object.freeze({
    group_count: groups.length,
    case_count: observedIds.size,
    exact_counts: wave22ClosureExpectedCaseCounts,
    passed: true as const,
  });
}
