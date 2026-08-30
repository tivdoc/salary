const GT_HISTORICAL_CASE_IDS = Object.freeze([
  "GT_NEG_001_DISTINCT_ANNOTATORS",
  "GT_NEG_002_EMPTY_TEMPLATE",
  "GT_NEG_003_MISSING_EVIDENCE",
  "GT_NEG_004_HASH_MISMATCH",
  "GT_NEG_005_INVALID_GEOMETRY",
  "GT_NEG_006_DUPLICATE_FIELD",
  "GT_NEG_007_LOCKED_MUTATION",
]);
const GT_REDERIVED_SUBSET_CASE_IDS = Object.freeze(GT_HISTORICAL_CASE_IDS.slice(0, 5));

export function reportingReconciliation() {
  const reconciliations = Object.freeze([
    Object.freeze({
      reconciliation_id: "REPORT_RECONCILIATION_001_GROUND_TRUTH",
      ambiguity: "Ground Truth 7/7 versus 5/5",
      dimensions: Object.freeze([
        Object.freeze({ dimension_id: "GT_V041_NEGATIVE_CASE_MATRIX", case_ids: GT_HISTORICAL_CASE_IDS, numerator: 7, denominator: 7, meaning: "the complete V0.4.1 negative-case matrix" }),
        Object.freeze({ dimension_id: "GT_V042_INDEPENDENT_REDERIVED_SUBSET", case_ids: GT_REDERIVED_SUBSET_CASE_IDS, numerator: 5, denominator: 5, omitted_case_ids: Object.freeze(GT_HISTORICAL_CASE_IDS.slice(5)), meaning: "the later independent verifier re-derived only a named five-case subset; it did not redefine the complete matrix" }),
      ]),
      reconciled: true,
    }),
    Object.freeze({
      reconciliation_id: "REPORT_RECONCILIATION_002_CONTROLLED_IMPORT",
      ambiguity: "command 38 exit zero versus strict operational denial",
      dimensions: Object.freeze([
        Object.freeze({ dimension_id: "COMMAND_038_LOCAL_CONTROLLED_IMPORT_HARNESS", command_id: 38, expected_exit: 0, actual_exit: 0, expectation_matched: true, subject_passed: true, subject: "local synthetic protocol and application-isolation harness" }),
        Object.freeze({ dimension_id: "COMMAND_030_OPERATIONAL_ADMISSION", command_id: 30, expected_exit: 5, actual_exit: 5, expectation_matched: true, subject_passed: false, subject_status: "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED", persistent_owner_import_entries: 0 }),
      ]),
      reconciled: true,
    }),
    Object.freeze({
      reconciliation_id: "REPORT_RECONCILIATION_003_W1_TEST_COUNTS",
      ambiguity: "W1 1/2 passed",
      dimensions: Object.freeze([
        Object.freeze({ dimension_id: "W1_FOCUSED_TEST_FILES", numerator: 1, denominator: 1, unit: "test_files" }),
        Object.freeze({ dimension_id: "W1_FOCUSED_TEST_CASES", numerator: 2, denominator: 2, unit: "tests" }),
      ]),
      canonical_label: "1 test file / 2 tests passed",
      reconciled: true,
    }),
    Object.freeze({
      reconciliation_id: "REPORT_RECONCILIATION_004_COMMAND_LEDGER",
      ambiguity: "reported table range 1-53 versus 51/51",
      dimensions: Object.freeze([
        Object.freeze({ dimension_id: "EXTERNAL_NARRATIVE_NUMBER_RANGE", reported_first: 1, reported_last: 53, reported_range_cardinality: 53, authority: "non-authoritative narrative label" }),
        Object.freeze({ dimension_id: "GENERATED_COMMAND_LEDGER", command_ids: Object.freeze(Array.from({ length: 51 }, (_, index) => index + 1)), first: 1, last: 51, listed_command_count: 51, expectation_matched_count: 51, denominator: 51, authority: "authoritative generated ledger inventory" }),
      ]),
      reconciled: true,
    }),
  ]);
  return Object.freeze({ schema_version: "tivdoc-reporting-reconciliation-v0.5.0" as const, reconciliations, totals: Object.freeze({ reconciliation_count: reconciliations.length, reconciled_count: reconciliations.filter((entry) => entry.reconciled).length }), passed: reconciliations.every((entry) => entry.reconciled) });
}
