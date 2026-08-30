import "./server-boundary.ts";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import { WAVE3_TOPICS } from "../../../engine/wave3/contracts.ts";
import type { InternalOpsFlagSnapshot } from "./flags.ts";
import {
  INTERNAL_OPS_SCHEMA_VERSION,
  internalOpsMutationRequestSchema,
  trustedCommand,
  type InternalOpsMutationRequest,
  type InternalOpsCommandResult,
  type OpsCapability,
  type OpsCapabilityProjection,
  type OpsProblemCode,
  type OpsReadProjection,
} from "./contracts.ts";
import { actorScopePermits, capabilitiesForRole, rolePermits } from "./policy.ts";
import type { InternalOpsPorts } from "./ports.ts";

export type InternalOpsReadKind =
  | "capabilities"
  | "queue"
  | "case"
  | "timeline"
  | "payment"
  | "documents"
  | "extraction"
  | "facts"
  | "readiness"
  | "analysis"
  | "report"
  | "audit";

const READ_CAPABILITY: Readonly<Record<InternalOpsReadKind, OpsCapability>> = Object.freeze({
  capabilities: "ops.read",
  queue: "queue.read",
  case: "case.read",
  timeline: "case.read",
  payment: "payment.read",
  documents: "document.read",
  extraction: "extraction.read",
  facts: "fact.read",
  readiness: "readiness.read",
  analysis: "analysis.read",
  report: "report.read",
  audit: "audit.read",
});

export class InternalOpsError extends Error {
  readonly code: OpsProblemCode;

  constructor(code: OpsProblemCode) {
    super(code);
    this.code = code;
    this.name = "InternalOpsError";
  }
}

export class InternalOpsService {
  readonly #ports: InternalOpsPorts;
  readonly #flags: InternalOpsFlagSnapshot;
  readonly #now: () => string;

  constructor(input: Readonly<{ ports: InternalOpsPorts; flags: InternalOpsFlagSnapshot; now?: () => string }>) {
    this.#ports = input.ports;
    this.#flags = input.flags;
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async authenticate(request: Request): Promise<VerifiedActor> {
    const actor = await this.#ports.identity.authenticate(request);
    if (!actor) throw new InternalOpsError("OPS_AUTH_REQUIRED");
    return actor;
  }

  async read(actor: VerifiedActor, kind: InternalOpsReadKind, caseId: string | null): Promise<OpsReadProjection> {
    const capability = READ_CAPABILITY[kind];
    await this.#guard(actor, capability, caseId);
    if (kind === "capabilities") return this.#capabilities(actor);
    if (kind === "queue") return this.#ports.projections.queue(actor);
    if (caseId === null) throw new InternalOpsError("OPS_INVALID_REQUEST");
    const projection = await this.#readCaseProjection(actor, kind, caseId);
    if (!projection) throw new InternalOpsError("OPS_NOT_FOUND");
    if (kind === "readiness") assertSevenTopicProjection(projection);
    return projection;
  }

  async mutate(actor: VerifiedActor, rawRequest: unknown, correlationId: string): Promise<InternalOpsCommandResult> {
    const parsed = internalOpsMutationRequestSchema.safeParse(rawRequest);
    if (!parsed.success) throw new InternalOpsError("OPS_INVALID_REQUEST");
    const request = parsed.data;
    const capability = `command.${request.payload.action}` as const;
    const scopeCaseId = request.payload.action === "case_create" ? null : request.payload.case_id;
    await this.#guard(actor, capability, scopeCaseId);
    this.#guardFeatureFlags(request);
    await this.#guardReportBinding(actor, request);
    const result = await this.#ports.commands.execute(trustedCommand(request, actor));
    if ("mutation" in result) {
      return Object.freeze({ ...result, mutation: Object.freeze({ ...result.mutation, correlation_id: correlationId }) });
    }
    return result.correlation_id === correlationId ? result : Object.freeze({ ...result, correlation_id: correlationId });
  }

  #capabilities(actor: VerifiedActor): OpsCapabilityProjection {
    return Object.freeze({
      schema_version: INTERNAL_OPS_SCHEMA_VERSION,
      actor_role: actor.role,
      capabilities: capabilitiesForRole(actor.role),
      manual_export_enabled: this.#flags.TIVDOC_MANUAL_REPORT_EXPORT_ENABLED,
      synthetic_enabled: this.#flags.TIVDOC_SYNTHETIC_OPS_ENABLED,
      customer_processing_enabled: this.#flags.TIVDOC_CUSTOMER_PROCESSING_ENABLED,
      customer_shadow_enabled: this.#flags.TIVDOC_CUSTOMER_SHADOW_ENABLED,
      production_delivery_enabled: false,
    });
  }

  async #guard(actor: VerifiedActor, capability: OpsCapability, caseId: string | null): Promise<void> {
    if (!rolePermits(actor.role, capability) || !actorScopePermits(actor, caseId, this.#now())) {
      throw new InternalOpsError("OPS_FORBIDDEN");
    }
    if (!(await this.#ports.identity.authorize(actor, capability, caseId))) {
      throw new InternalOpsError("OPS_FORBIDDEN");
    }
  }

  #guardFeatureFlags(request: InternalOpsMutationRequest): void {
    const payload = request.payload;
    const isAnalysis = payload.action === "analysis_request" || payload.action === "analysis_resume" || payload.action === "analysis_replay";
    if (isAnalysis && payload.mode === "synthetic_test" && !this.#flags.TIVDOC_SYNTHETIC_OPS_ENABLED) {
      throw new InternalOpsError("OPS_SYNTHETIC_DISABLED");
    }
    if (isAnalysis && payload.mode === "real" && !this.#flags.TIVDOC_CUSTOMER_PROCESSING_ENABLED) {
      throw new InternalOpsError("OPS_LEGAL_READINESS_BLOCKED");
    }
    if (payload.action === "report_manual_export" && !this.#flags.TIVDOC_MANUAL_REPORT_EXPORT_ENABLED) {
      throw new InternalOpsError("OPS_MANUAL_EXPORT_DISABLED");
    }
  }

  async #guardReportBinding(actor: VerifiedActor, request: InternalOpsMutationRequest): Promise<void> {
    const payload = request.payload;
    if (payload.action !== "report_submit" && payload.action !== "report_approve" && payload.action !== "report_reject" && payload.action !== "report_manual_export") return;
    const current = await this.#ports.projections.report(actor, payload.case_id);
    if (!current) throw new InternalOpsError("OPS_NOT_FOUND");
    if (current.report_sha256 !== payload.report_sha256 || current.report_revision !== payload.report_revision) {
      throw new InternalOpsError("OPS_UPSTREAM_INVALIDATED");
    }
    if (payload.action !== "report_manual_export" && current.analysis_result_sha256 !== payload.analysis_result_sha256) {
      throw new InternalOpsError("OPS_UPSTREAM_INVALIDATED");
    }
    if (payload.action === "report_submit" && current.status !== "internal_draft") throw new InternalOpsError("OPS_COMMAND_REJECTED");
    if ((payload.action === "report_approve" || payload.action === "report_reject") && current.status !== "awaiting_approval") {
      throw new InternalOpsError("OPS_EXACT_REPORT_APPROVAL_REQUIRED");
    }
    if (payload.action === "report_manual_export") {
      if (current.status !== "approved" || current.exact_hash_approval_receipt_sha256 !== payload.approval_receipt_sha256 || !current.manual_export_eligible) {
        throw new InternalOpsError("OPS_EXACT_REPORT_APPROVAL_REQUIRED");
      }
    }
  }

  async #readCaseProjection(actor: VerifiedActor, kind: Exclude<InternalOpsReadKind, "capabilities" | "queue">, caseId: string) {
    switch (kind) {
      case "case": return this.#ports.projections.case(actor, caseId);
      case "timeline": return this.#ports.projections.timeline(actor, caseId);
      case "payment": return this.#ports.projections.payment(actor, caseId);
      case "documents": return this.#ports.projections.documents(actor, caseId);
      case "extraction": return this.#ports.projections.extraction(actor, caseId);
      case "facts": return this.#ports.projections.facts(actor, caseId);
      case "readiness": return this.#ports.projections.readiness(actor, caseId);
      case "analysis": return this.#ports.projections.analysis(actor, caseId);
      case "report": return this.#ports.projections.report(actor, caseId);
      case "audit": return this.#ports.projections.audit(actor, caseId);
    }
  }
}

function assertSevenTopicProjection(projection: OpsReadProjection): void {
  if (!("topics" in projection)) throw new InternalOpsError("OPS_COMMAND_REJECTED");
  const topics = projection.topics.map((item) => item.topic);
  if (topics.length !== WAVE3_TOPICS.length || WAVE3_TOPICS.some((topic) => topics.filter((value) => value === topic).length !== 1)) {
    throw new InternalOpsError("OPS_COMMAND_REJECTED");
  }
  const computedReady = projection.topics.every((item) => item.status === "READY");
  if (computedReady !== projection.all_topics_ready || projection.topics.some((item) => item.status === "BLOCKED_NOT_READY" && item.blocker_codes.length === 0)) {
    throw new InternalOpsError("OPS_COMMAND_REJECTED");
  }
}
