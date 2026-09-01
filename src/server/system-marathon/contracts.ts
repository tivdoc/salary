export const MARATHON_SCHEMA_VERSION = "tivdoc-full-local-system-marathon-v0.10.0" as const;

export const MARATHON_CLASSIFICATIONS = [
  "ALREADY_CANONICAL_AND_PROVEN",
  "IMPLEMENTED_NOT_WIRED",
  "PARTIAL",
  "CONTRACT_ONLY",
  "SCHEMA_ONLY",
  "MISSING",
  "EXTERNAL_OR_HUMAN_BLOCKED",
  "OUT_OF_SCOPE_FOR_SAFETY",
] as const;
export type MarathonClassification = (typeof MARATHON_CLASSIFICATIONS)[number];

export const MARATHON_ACCEPTANCE_STATUSES = [
  "PASS",
  "FAIL",
  "BLOCKED",
  "SKIPPED_DEPENDENCY",
  "NOT_APPLICABLE",
] as const;
export type MarathonAcceptanceStatus = (typeof MARATHON_ACCEPTANCE_STATUSES)[number];

export const MARATHON_CAPABILITY_IDS = [
  "W1.1", "W1.2", "W1.3",
  "W2.1", "W2.2", "W2.3", "W2.4",
  "W3.1", "W3.2", "W3.3",
  "W4.1", "W4.2", "W4.3",
  "W5.1", "W5.2", "W5.3",
  "W6.1", "W6.2", "W6.3", "W6.4",
  "W7.1", "W7.2", "W7.3",
  "W8.1", "W8.2", "W8.3",
  "W9.1", "W9.2", "W9.3", "W9.4",
] as const;
export type MarathonCapabilityId = (typeof MARATHON_CAPABILITY_IDS)[number];

export const MARATHON_ACCEPTANCE_IDS = Object.freeze(
  Array.from({ length: 39 }, (_, index) => `MC-${String(index + 1).padStart(2, "0")}`),
) as readonly `MC-${string}`[];

export const MARATHON_WORKER_LANES = [
  "W1_PLATFORM_TRUST",
  "W2_PRODUCT_DURABILITY",
  "W3_IMPORT_SANDBOX",
  "W4_HUMAN_LEGAL_TRUST",
  "W7_SHADOW_OBSERVABILITY",
  "W8_CUSTODY_PRIVACY",
  "W9_CLOSURE_HARDENING",
] as const;
export type MarathonWorkerLane = (typeof MARATHON_WORKER_LANES)[number];

export const MARATHON_REQUIRED_BASE = Object.freeze({
  branch: "codex/tivdoc-engine-foundation",
  head: "28d18da69108913252736f4b8a39c4ef614984a3",
  tree: "2a9859470003a095521a13e21474a45e1f69620e",
});

export const MARATHON_TRUTH_BASELINE = Object.freeze({
  REAL_LEGAL_TOPICS_READY: "0/7",
  REAL_SOURCES_ACTIVE: 0,
  REAL_PARAMETERS_ACTIVE: 0,
  REAL_RULES_ACTIVE: 0,
  REAL_CALCULATIONS_OR_FINDINGS: 0,
  HUMAN_GROUND_TRUTH_LOCKED: 0,
  REAL_CUSTOMER_DATA_READS: 0,
  CUSTOMER_PROCESSING_ENABLED: "NO",
  CUSTOMER_SHADOW_AUTHORIZED: "NO",
  PRODUCTION_DELIVERY_ENABLED: "NO",
  DEPLOYMENTS: 0,
  REMOTE_MIGRATIONS: 0,
  LIVE_PROVIDER_CALLS: 0,
  OPENAI_CALLS: 0,
  PRODUCT_REACHABLE_MEMORY_FALLBACKS: 0,
});
