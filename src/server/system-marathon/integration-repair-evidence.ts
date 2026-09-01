import { createHash } from "node:crypto";
import path from "node:path";

export const V0101_HEADLINES = Object.freeze([
  "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN",
  "V0101_ENGINEERING_INTEGRATION_PARTIAL",
  "BLOCKED_SAFETY_OR_REPOSITORY_STATE",
] as const);

export const V0101_RESULT_STATUSES = Object.freeze(["PASS", "FAIL", "BLOCKED"] as const);
export type V0101ResultStatus = (typeof V0101_RESULT_STATUSES)[number];

export type V0101EvidenceEntry = Readonly<{
  path: string;
  sha256: string;
  byte_count: number;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const REQUIRED_ZERO_COUNTERS = Object.freeze([
  "REAL_SOURCES_ACTIVE",
  "REAL_PARAMETERS_ACTIVE",
  "REAL_RULES_ACTIVE",
  "REAL_CALCULATIONS_OR_FINDINGS",
  "HUMAN_GROUND_TRUTH_LOCKED",
  "REAL_CUSTOMER_DATA_READS",
  "DEPLOYMENTS",
  "REMOTE_MIGRATIONS",
  "LIVE_PROVIDER_CALLS",
  "OPENAI_CALLS",
  "PRODUCT_REACHABLE_MEMORY_FALLBACKS",
] as const);
const REQUIRED_NO_COUNTERS = Object.freeze([
  "CUSTOMER_PROCESSING_ENABLED",
  "CUSTOMER_SHADOW_AUTHORIZED",
  "PRODUCTION_DELIVERY_ENABLED",
] as const);

export function assertPortableEvidencePath(value: string): void {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
      || path.posix.normalize(value) !== value || !/^[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error("V0101_EVIDENCE_PATH_UNSAFE");
  }
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
      || segment.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new Error("V0101_EVIDENCE_PATH_UNSAFE");
  }
}

export function canonicalPayloadSetHash(entries: readonly V0101EvidenceEntry[]): string {
  const unique = new Set<string>();
  const portable = new Set<string>();
  const sorted = [...entries].sort((left, right) => compare(left.path, right.path));
  for (const entry of sorted) {
    assertPortableEvidencePath(entry.path);
    const folded = entry.path.toLowerCase();
    if (unique.has(entry.path) || portable.has(folded)) throw new Error("V0101_EVIDENCE_PATH_DUPLICATE");
    if (!SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.byte_count) || entry.byte_count < 0) {
      throw new Error("V0101_EVIDENCE_ENTRY_INVALID");
    }
    unique.add(entry.path);
    portable.add(folded);
  }
  const payload = sorted.map((entry) => `${entry.path}\0${entry.sha256}\0${entry.byte_count}\n`).join("");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function parseOrderedIntegrationLedger(raw: string): readonly Readonly<Record<string, unknown>>[] {
  const lines = raw.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length < 1) throw new Error("V0101_LEDGER_EMPTY");
  const entries = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("V0101_LEDGER_MALFORMED");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_LEDGER_MALFORMED");
    const record = value as Record<string, unknown>;
    const expected = `IRL-${String(index + 1).padStart(4, "0")}`;
    if (record.event_id !== expected) throw new Error("V0101_LEDGER_ORDER_INVALID");
    return Object.freeze(record);
  });
  return Object.freeze(entries);
}

export function validateV0101Assessment(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("V0101_ASSESSMENT_MALFORMED");
  const assessment = value as Record<string, unknown>;
  if (assessment.schema_version !== "tivdoc-canonical-integration-durability-repair-assessment-v0.10.1") {
    throw new Error("V0101_ASSESSMENT_SCHEMA_INVALID");
  }
  if (!(V0101_HEADLINES as readonly unknown[]).includes(assessment.headline)) throw new Error("V0101_ASSESSMENT_HEADLINE_INVALID");
  if (!SHA256.test(String(assessment.verified_head)) || !SHA256.test(String(assessment.verified_tree))) {
    throw new Error("V0101_ASSESSMENT_GIT_INVALID");
  }
  const mc = exactResults(assessment.mc_results, "MC", 39);
  const ir = exactResults(assessment.ir_results, "IR", 27);
  const truth = record(assessment.truth, "V0101_ASSESSMENT_TRUTH_INVALID");
  for (const name of REQUIRED_ZERO_COUNTERS) {
    if (truth[name] !== 0) throw new Error(`V0101_TRUTH_COUNTER_NOT_ZERO:${name}`);
  }
  for (const name of REQUIRED_NO_COUNTERS) {
    if (truth[name] !== "NO") throw new Error(`V0101_TRUTH_COUNTER_NOT_NO:${name}`);
  }
  if (truth.REAL_LEGAL_TOPICS_READY !== "0/7") throw new Error("V0101_REAL_LEGAL_TOPICS_INVALID");
  const corePass = mc.filter((item) => !["MC-03", "MC-10", "MC-27"].includes(item.id) && item.status === "PASS").length;
  const coreFail = mc.filter((item) => !["MC-03", "MC-10", "MC-27"].includes(item.id) && item.status !== "PASS").length;
  if (truth.CORE_LOCAL_MC_PASS !== `${corePass}/36` || truth.CORE_LOCAL_MC_FAIL !== coreFail) {
    throw new Error("V0101_CORE_COUNTER_CONTRADICTION");
  }
  const runCounts = record(assessment.run_counts, "V0101_RUN_COUNTS_INVALID");
  for (const name of ["FULL_SUITE_RUN_COUNT", "PRODUCTION_BUILD_RUN_COUNT", "BROWSER_E2E_FULL_RUN_COUNT", "POSTGRESQL_FULL_REGRESSION_RUN_COUNT"]) {
    if (!Number.isSafeInteger(runCounts[name]) || (runCounts[name] as number) < 0) throw new Error(`V0101_RUN_COUNT_INVALID:${name}`);
    if (truth[name] !== runCounts[name]) throw new Error(`V0101_RUN_COUNT_CONTRADICTION:${name}`);
  }
  const blockers = Array.isArray(assessment.blockers) ? assessment.blockers : [];
  for (const item of blockers) {
    const blocker = record(item, "V0101_BLOCKER_INVALID");
    const id = String(blocker.id);
    const result = [...mc, ...ir].find((candidate) => candidate.id === id);
    if (!result || result.status === "PASS") throw new Error("V0101_BLOCKER_FALSE_PASS");
    if (typeof blocker.reason !== "string" || blocker.reason.length < 3) throw new Error("V0101_BLOCKER_REASON_INVALID");
  }
  if (assessment.headline === "V0101_ENGINEERING_INTEGRATION_COMPLETE_EXTERNAL_AND_HUMAN_GATES_REMAIN"
      && (corePass !== 36 || coreFail !== 0 || ir.some((item) => item.status === "FAIL"))) {
    throw new Error("V0101_COMPLETE_HEADLINE_CONTRADICTION");
  }
}

function exactResults(value: unknown, prefix: "MC" | "IR", count: number): readonly Readonly<{ id: string; status: V0101ResultStatus }>[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error(`V0101_${prefix}_RESULT_COUNT_INVALID`);
  return Object.freeze(value.map((item, index) => {
    const result = record(item, `V0101_${prefix}_RESULT_INVALID`);
    const expected = `${prefix}-${String(index + 1).padStart(2, "0")}`;
    if (result.id !== expected || !(V0101_RESULT_STATUSES as readonly unknown[]).includes(result.status)) {
      throw new Error(`V0101_${prefix}_RESULT_INVALID`);
    }
    if (!Array.isArray(result.evidence) || result.evidence.length < 1
        || result.evidence.some((entry) => typeof entry !== "string" || entry.length < 1)) {
      throw new Error(`V0101_${prefix}_EVIDENCE_INVALID`);
    }
    if (result.status !== "PASS" && (typeof result.reason !== "string" || result.reason.length < 3)) {
      throw new Error(`V0101_${prefix}_NONPASS_REASON_INVALID`);
    }
    return Object.freeze({ id: expected, status: result.status as V0101ResultStatus });
  }));
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
