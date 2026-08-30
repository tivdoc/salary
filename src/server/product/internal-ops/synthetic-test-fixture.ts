import "./server-boundary.ts";

import { createHash } from "node:crypto";
import { evaluateLegalReadiness, type LegalReadinessCandidate } from "../../../engine/legal-knowledge/canonical-readiness/evaluate-legal-readiness.ts";
import type { V07Role, VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import { INTERNAL_OPS_SCHEMA_VERSION, type InternalOpsAction, type InternalOpsCommandResult, type MutationResultProjection, type ReportProjection, type TrustedInternalOpsCommand } from "./contracts.ts";
import type { InternalOpsPorts } from "./ports.ts";

const CASE_ID = "syn-case-ops-001";
const SHA = Object.freeze({
  a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64), d: "d".repeat(64), e: "e".repeat(64), f: "f".repeat(64),
});

function fixtureGuard(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    const error = new Error("OPS_PRODUCTION_FIXTURE_FORBIDDEN") as Error & { code: string };
    error.code = "OPS_PRODUCTION_FIXTURE_FORBIDDEN";
    throw error;
  }
}

export type SyntheticOpsFixture = Readonly<{
  ports: InternalOpsPorts;
  caseId: string;
  actor(role: V07Role): VerifiedActor;
  mutationCount(): number;
  setRole(role: V07Role): void;
  setRealBlocked(): void;
  setPaymentAdverse(): void;
}>;

export function createSyntheticOpsFixture(nodeEnv?: string): SyntheticOpsFixture {
  fixtureGuard(nodeEnv);
  let currentRole: V07Role = "intake_operator";
  let revision = 4;
  let state: MutationResultProjection["state"] = "awaiting_fact_resolution";
  let mutationCount = 0;
  let realBlocked = false;
  let paymentAdverse = false;
  let report: ReportProjection = reportProjection("awaiting_approval", null, false);
  const idempotency = new Map<string, Readonly<{ digest: string; result: InternalOpsCommandResult }>>();

  const actor = (role: V07Role): VerifiedActor => Object.freeze({
    actor_id: `syn-actor-${role}`,
    role,
    tenant_id: "syn-tenant-001",
    assigned_case_ids: [CASE_ID],
    verified_server_side: true,
    break_glass_reason: role === "break_glass_admin" ? "synthetic emergency review" : null,
    break_glass_expires_at: role === "break_glass_admin" ? "2099-01-01T00:00:00.000Z" : null,
  });

  const readiness = () => Object.freeze({
    schema_version: INTERNAL_OPS_SCHEMA_VERSION,
    case_id: CASE_ID,
    topics: Object.freeze(WAVE3_TOPICS.map((topic) => {
      const decision = evaluateLegalReadiness({
        readinessCase: Object.freeze({ case_id: CASE_ID, topic, kind: realBlocked ? "current" : "synthetic", target_date: "2030-01-15", as_of: "2030-02-01", sector: "SYN_SECTOR", population: "SYN_POPULATION", contract_version: "v0.5.0", use_case: "monetary_rule" }),
        candidates: realBlocked ? [] : [syntheticReadyCandidate(topic)],
      });
      return Object.freeze({ topic, status: decision.status, blocker_codes: decision.reason_codes, decision_sha256: decision.decision_sha256, decision_source: decision.decision_source });
    })),
    all_topics_ready: !realBlocked,
  });

  const ports: InternalOpsPorts = Object.freeze({
    identity: Object.freeze({
      async authenticate() { return actor(currentRole); },
      async authorize() { return true; },
    }),
    projections: Object.freeze({
      async queue() { return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, items: [Object.freeze({ case_id: CASE_ID, revision, state, blocker_count: realBlocked ? 7 : 1, next_action_code: "FACT_REVIEW_REQUIRED", updated_at: "2030-02-01T10:00:00.000Z" })], next_cursor: null }); },
      async case(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, revision, state, mode: realBlocked ? "real" : "synthetic_test", created_at: "2030-01-01T10:00:00.000Z", updated_at: "2030-02-01T10:00:00.000Z", snapshot_hashes: hashes(), invalidation_codes: report.status === "invalidated" ? ["UPSTREAM_FACTS_CHANGED"] : [], blocker_codes: realBlocked ? ["LEGAL_SOURCE_CORPUS_INCOMPLETE"] : ["FACT_REVIEW_REQUIRED"] }) : null; },
      async timeline(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, events: [Object.freeze({ sequence: 1, event_code: "case_created", revision: 0, occurred_at: "2030-01-01T10:00:00.000Z", actor_role: "intake_operator" as const, event_sha256: SHA.a })] }) : null; },
      async payment(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, status: paymentAdverse ? "refunded" as const : "settled" as const, evidence_revision: "rev-001", evidence_sha256: SHA.b, reference_sha256: SHA.c, hold: paymentAdverse }) : null; },
      async documents(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, documents: [Object.freeze({ object_version_id: "syn-object-001", object_sha256: SHA.c, byte_length: 1024, detected_mime: "application/pdf", status: "accepted" as const })] }) : null; },
      async extraction(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, snapshot_sha256: SHA.d, fields: [Object.freeze({ field_id: "syn-field-001", canonical_path: "synthetic.measurement", status: "candidate" as const, confidence_micros: 900_000, source_document_id: "syn-object-001" })] }) : null; },
      async facts(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, snapshot_sha256: SHA.e, facts: [Object.freeze({ fact_id: "syn-fact-001", canonical_path: "synthetic.measurement", status: "needs_confirmation" as const, provenance_count: 1, conflict_count: 0 })] }) : null; },
      async readiness(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? readiness() : null; },
      async analysis(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, runs: [Object.freeze({ analysis_run_id: "syn-analysis-001", status: realBlocked ? "blocked" as const : "complete" as const, input_snapshot_sha256: SHA.e, result_sha256: realBlocked ? null : SHA.f, known_subtotal_minor_units: null, coverage_complete: !realBlocked, blocker_codes: realBlocked ? ["LEGAL_SOURCE_CORPUS_INCOMPLETE"] : [] })] }) : null; },
      async report(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? report : null; },
      async audit(_actor: VerifiedActor, caseId: string) { return caseId === CASE_ID ? Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, chain_valid: true, event_count: mutationCount + 1, tail_sha256: SHA.a, events: [Object.freeze({ sequence: 1, action: "case_created", resource_revision: 0, resource_sha256: SHA.a, event_sha256: SHA.b, occurred_at: "2030-01-01T10:00:00.000Z" })] }) : null; },
    }),
    commands: Object.freeze({
      async execute(command: TrustedInternalOpsCommand) {
        const digest = hash({ ...command, actor: { actor_id: command.actor.actor_id, role: command.actor.role } });
        const replay = idempotency.get(command.idempotency_key);
        if (replay) {
          if (replay.digest !== digest) throw coded("idempotency_conflict");
          return "mutation" in replay.result
            ? Object.freeze({ ...replay.result, mutation: Object.freeze({ ...replay.result.mutation, idempotent_replay: true }) })
            : Object.freeze({ ...replay.result, idempotent_replay: true });
        }
        if (command.expected_revision !== revision) throw coded("revision_conflict");
        mutationCount += 1;
        revision += 1;
        applyFixtureMutation(command.payload.action);
        const result = Object.freeze({
          schema_version: INTERNAL_OPS_SCHEMA_VERSION,
          case_id: command.payload.case_id,
          revision,
          state,
          command_sha256: digest,
          audit_event_sha256: hash({ digest, revision }),
          idempotent_replay: false,
          snapshot_hashes: hashes(),
          invalidation_codes: [
            ...(report.status === "invalidated" ? ["UPSTREAM_FACTS_CHANGED"] : []),
            ...(paymentAdverse ? ["PAYMENT_REFUNDED"] : []),
          ],
          blocker_codes: realBlocked ? ["LEGAL_SOURCE_CORPUS_INCOMPLETE"] : [],
          correlation_id: "fixture:replaced-by-http",
        }) satisfies MutationResultProjection;
        const commandResult: InternalOpsCommandResult = command.payload.action === "report_manual_export"
          ? exportResult(result, command.payload.format)
          : result;
        idempotency.set(command.idempotency_key, Object.freeze({ digest, result: commandResult }));
        return commandResult;
      },
    }),
  });

  function applyFixtureMutation(action: InternalOpsAction): void {
    if (action === "fact_resolution") report = reportProjection("invalidated", null, false);
    if (action === "report_approve") report = reportProjection("approved", SHA.b, true);
    if (action === "payment_reconcile" && paymentAdverse) {
      state = "release_hold";
      report = reportProjection("invalidated", null, false);
    }
  }

  return Object.freeze({
    ports,
    caseId: CASE_ID,
    actor,
    mutationCount: () => mutationCount,
    setRole: (role: V07Role) => { currentRole = role; },
    setRealBlocked: () => { realBlocked = true; },
    setPaymentAdverse: () => { paymentAdverse = true; },
  });
}

function syntheticReadyCandidate(topic: string): LegalReadinessCandidate {
  const version = `syn-source-version-${topic}`;
  const candidate: LegalReadinessCandidate = {
    source_version_id: version,
    source_id: `syn-source-${topic}`,
    topics: [topic],
    parse_succeeded: true,
    citation_verified: true,
    operative_role_eligible: true,
    human_reviewed: true,
    effective_interval_verified: true,
    verified_sectors: ["SYN_SECTOR"],
    verified_populations: ["SYN_POPULATION"],
    active: true,
    acquisition_status: "available",
    technical_parse_status: "parsed",
    instrument_boundary_status: "resolved",
    publication_status: "review_candidate",
    retrieval_visibility: "visible",
    retrieval_surface: "canonical_review",
    source_role: "binding_role_candidate",
    monetary_support_eligibility: "eligible",
    citation: { citation_id: `syn-citation-${topic}`, verified: true, source_version_id: version },
    review_attestation: { attestation_id: `syn-review-${topic}`, status: "reviewed", source_version_id: version, reviewed_at: "2030-01-20" },
    valid_time: { from: "2030-01-01", to: "2030-12-31", verified: true },
    knowledge_time: { available_from: "2030-01-20", unavailable_from: null },
    sector_status: "verified",
    population_status: "verified",
    activation_status: "active",
    bound_source_version_id: version,
  };
  return Object.freeze(candidate);
}

function reportProjection(status: ReportProjection["status"], receipt: string | null, eligible: boolean): ReportProjection {
  return Object.freeze({ schema_version: INTERNAL_OPS_SCHEMA_VERSION, case_id: CASE_ID, report_id: "syn-report-001", report_revision: 4, report_sha256: SHA.a, analysis_result_sha256: SHA.f, status, coverage_complete: true, watermark: "INTERNAL_DRAFT_NOT_FOR_CUSTOMER", exact_hash_approval_receipt_sha256: receipt, manual_export_eligible: eligible, blocker_codes: [] });
}

function hashes() {
  return Object.freeze({ documents: SHA.c, extraction: SHA.d, facts: SHA.e, analysis: SHA.f, report: SHA.a });
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exportResult(mutation: MutationResultProjection, format: "json" | "html" | "pdf" | "manifest"): InternalOpsCommandResult {
  const bytes = new TextEncoder().encode(format === "pdf" ? "%PDF-1.7\n% synthetic internal artifact\n" : "{\"synthetic_internal_artifact\":true}\n");
  const media_type = format === "pdf" ? "application/pdf" as const : format === "html" ? "text/html; charset=utf-8" as const : "application/json" as const;
  return Object.freeze({ mutation, format, media_type, artifact_sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
