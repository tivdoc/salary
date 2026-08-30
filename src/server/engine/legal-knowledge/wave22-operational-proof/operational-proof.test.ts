import { describe, expect, it } from "vitest";
import { runWave22OperationalProof } from "./operational-proof.ts";

describe("Wave 2.2 actual-reader operational proof", () => {
  it("binds opened bytes and denies owner visibility before persistent prerequisites exist", async () => {
    const report = await runWave22OperationalProof();
    expect(report).toMatchObject({
      overall: true,
      persistent_owner_import_entries: 0,
      assurance: {
        application: "PARSER_APPLICATION_ISOLATION_VERIFIED",
        os: "PARSER_OS_SANDBOX_NOT_VERIFIED",
        owner_imports: "PERSISTENT_OWNER_IMPORTS_NOT_VERIFIED",
        custody: "DURABLE_REPLICATED_CUSTODY_NOT_IMPLEMENTED",
      },
      toctou: {
        passed: true,
        direct_mutation_error: "controlled_commit_artifact_bytes_mismatch",
        citation_count_after_failure: 0,
        chunk_count_after_failure: 0,
        retrieval_result_count_after_failure: 0,
        source_binding: { content_open_count: 1, passed: true },
      },
      owner_denial: {
        passed: true,
        safe_error_code: "owner_import_disabled_parser_os_sandbox_not_verified",
        owner_artifact_imported: false,
        visible: false,
        persistent_owner_import_entries: 0,
        strict_operational_readiness: {
          exit_code: 5,
          missing_gates: [
            "durable_replicated_storage_not_verified",
            "parser_os_sandbox_not_verified",
            "persistence_evidence_not_verified",
            "persistent_ledger_not_verified",
            "persistent_owner_imports_zero",
          ],
        },
      },
    });
  }, 30_000);
});
