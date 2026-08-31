export const PERSISTENCE_RUNTIME_MODES = ["memory_test_only", "isolated_postgres", "disabled"] as const;
export type PersistenceRuntimeMode = (typeof PERSISTENCE_RUNTIME_MODES)[number];
