import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PERSISTENCE_ARCHITECTURE_ANSWERS,
  PERSISTENCE_CAPABILITIES,
  PERSISTENCE_WIRING_MAP,
  PERSISTENCE_WIRING_SUMMARY,
  REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY,
  renderPersistenceWiringMarkdown,
} from "./wiring-map";
import { verifyCanonicalPersistenceWiringStatically } from "./wiring-verifier";

describe("canonical persistence wiring audit", () => {
  it("classifies every required capability with zero unknowns", () => {
    expect(PERSISTENCE_WIRING_MAP.map((row) => row.capability)).toEqual(PERSISTENCE_CAPABILITIES);
    expect(PERSISTENCE_WIRING_MAP).toHaveLength(14);
    expect(PERSISTENCE_WIRING_SUMMARY).toMatchObject({
      capability_count: 14,
      unknown_count: 0,
      duplicate_canonical_contract_count: 0,
      wired_durable_count: 14,
      status: "CANONICAL_PERSISTENCE_WIRING_COMPLETE",
      blocker: "DYNAMIC_POSTGRESQL_VERIFICATION_PENDING",
    });
    expect(REPORTED_19_DESCRIPTOR_OR_SCHEMA_ONLY).toHaveLength(19);
  });

  it("answers all seven architecture questions without dynamic database overclaim", () => {
    expect(PERSISTENCE_ARCHITECTURE_ANSWERS.durable_non_test_service_bindings).toHaveLength(14);
    expect(PERSISTENCE_ARCHITECTURE_ANSWERS.shared_case_revision).toContain("Real PostgreSQL replay remains pending");
    expect(PERSISTENCE_ARCHITECTURE_ANSWERS.shared_command_transaction).toContain("real PostgreSQL transaction semantics remain pending");
    expect(PERSISTENCE_ARCHITECTURE_ANSWERS.reported_19_descriptor_or_schema_only).toHaveLength(19);
    expect(renderPersistenceWiringMarkdown()).toContain("DYNAMIC_POSTGRESQL_VERIFICATION_PENDING");
  });

  it("passes the static source/schema audit while keeping database semantics false", () => {
    const receipt = verifyCanonicalPersistenceWiringStatically({
      platform_migration: [
        readFileSync("supabase/migrations/202608310001_engine_platform_persistence.sql", "utf8"),
        readFileSync("supabase/migrations/202608310002_canonical_postgresql_composition.sql", "utf8"),
      ].join("\n"),
      composition_root: [
        readFileSync("src/server/platform/composition/canonical-postgres.ts", "utf8"),
        readFileSync("src/server/platform/composition/canonical-postgres-application.ts", "utf8"),
      ].join("\n"),
      isolated_environment: readFileSync("src/server/platform/persistence/isolated-environment.ts", "utf8"),
      product_reachable_sources: [],
    });
    expect(receipt.status).toBe("PASS_STATIC_WIRING_AUDIT");
    expect(receipt.database_semantics_verified).toBe(false);
    expect(receipt.canonical_persistence_wiring_complete).toBe(true);
    expect(receipt.case_analysis_non_durable_only).toBe(false);
    expect(receipt.counts).toMatchObject({
      capabilities: 14,
      unknown: 0,
      duplicate_canonical_contracts: 0,
      wired_durable: 14,
      product_reachable_memory_constructors: 0,
      reported_descriptor_or_schema_only: 19,
    });
  });
});
