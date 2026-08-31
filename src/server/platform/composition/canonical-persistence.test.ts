import { describe, expect, it } from "vitest";

import {
  createCanonicalPersistenceComposition,
  parsePersistenceRuntimeMode,
  PersistenceCompositionError,
  requireOperationalPersistence,
} from "./canonical-persistence";

const storageConfig = {
  private_storage_root: "C:/tmp/tivdoc-w1-memory-test",
  now_ms: () => 0,
  authorize_read: () => false,
} as const;

describe("canonical persistence composition", () => {
  it("requires one of the three explicit runtime modes", () => {
    expect(() => parsePersistenceRuntimeMode(undefined)).toThrowError("PERSISTENCE_MODE_REQUIRED");
    expect(() => parsePersistenceRuntimeMode("memory")).toThrowError("PERSISTENCE_MODE_INVALID");
    expect(parsePersistenceRuntimeMode("memory_test_only")).toBe("memory_test_only");
    expect(parsePersistenceRuntimeMode("isolated_postgres")).toBe("isolated_postgres");
    expect(parsePersistenceRuntimeMode("disabled")).toBe("disabled");
  });

  it("rejects the memory adapter outside test or hermetic synthetic execution", () => {
    expect(() => createCanonicalPersistenceComposition({
      mode: "memory_test_only",
      execution_boundary: "non_test",
      ...storageConfig,
    })).toThrowError("MEMORY_TEST_ONLY_OUTSIDE_HERMETIC_EXECUTION");
  });

  it("constructs all local adapters only through the hermetic composition root", () => {
    const composition = createCanonicalPersistenceComposition({
      mode: "memory_test_only",
      execution_boundary: "hermetic_synthetic",
      ...storageConfig,
    });
    expect(composition.mode).toBe("memory_test_only");
    expect(composition.durable).toBe(false);
    expect(requireOperationalPersistence(composition)).toBe(composition);
    if (composition.mode === "memory_test_only") {
      expect(composition.canonical_repository).toBeDefined();
      expect(composition.case_analysis_repository).toBeDefined();
      expect(composition.jobs).toBeDefined();
      expect(composition.audit).toBeDefined();
      expect(composition.private_storage).toBeDefined();
    }
  });

  it("does not fall back to memory when isolated PostgreSQL is selected", () => {
    expect(() => createCanonicalPersistenceComposition({
      mode: "isolated_postgres",
      execution_boundary: "non_test",
      target_id: "tivdoc-isolated-12345678",
    })).toThrowError("ISOLATED_POSTGRES_ADAPTER_NOT_IMPLEMENTED");
  });

  it("fails closed when a disabled composition is required operationally", () => {
    const composition = createCanonicalPersistenceComposition({ mode: "disabled", execution_boundary: "non_test" });
    expect(composition).toEqual({ mode: "disabled", durable: false, reason: "PERSISTENCE_DISABLED" });
    expect(() => requireOperationalPersistence(composition)).toThrow(PersistenceCompositionError);
  });
});
