import "../server-boundary.ts";

import type { VerifiedActor, V07Role } from "../../../../engine/wave4/contracts.ts";
import {
  createDurableGovernanceApplication,
  governanceIdSchema,
  governanceVersionSchema,
  governanceWorkEnqueueSchema,
  type DurableGovernanceApplication,
  type GovernanceAggregateSnapshot,
  type GovernanceMutationReceipt,
  type GovernanceWorkQueueEntry,
  type GovernanceWorkflowKind,
  type HistoricalObservationImportReceipt,
} from "../../../platform/persistence/postgres/governance/index.ts";
import type {
  DurableProductRouteContext,
  DurableProductRouteServiceAdapter,
} from "../../routes/durable-registration.ts";
import type { LegalReviewAction, LegalReviewDurableRow, LegalReviewPacket } from "../../../../engine/legal-review/contracts.ts";
import { buildLegalTopicReadiness, type LegalTopicEvidence, type LegalTopicReadiness } from "../../../../engine/legal-review/topic-readiness.ts";
import type { InternalOpsApplicationPort } from "../application-port.ts";
import type { InternalOpsCommandResult, OpsReadProjection } from "../contracts.ts";
import { actorScopePermits } from "../policy.ts";
import type { InternalOpsReadKind } from "../service.ts";
import {
  DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
  DURABLE_GOVERNANCE_WORK_LANES,
  DURABLE_OPERATIONS_TABS,
  type DurableGovernanceClaimResult,
  type DurableGovernanceCommand,
  type DurableGovernanceCommandResult,
  type DurableGovernanceOperationsProof,
  type DurableGovernanceOperationsScope,
  type DurableGovernanceWorkLane,
  type DurableOperationsTab,
  type DurableOperationsTabProjection,
  type DurableReviewerTrustProjection,
  type GovernanceAggregateReference,
} from "./contracts.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;

/** Who may read the nested Legal Review workspace, mirroring the Legal tab. */
const LEGAL_REVIEW_READ_ROLES = Object.freeze([
  "legal_reviewer", "report_approver", "auditor", "break_glass_admin",
] as const satisfies readonly V07Role[]);

/** An auditor observes; only a reviewer or approver may submit an action. */
const LEGAL_REVIEW_ACTION_ROLES = Object.freeze([
  "legal_reviewer", "report_approver", "break_glass_admin",
] as const satisfies readonly V07Role[]);

/**
 * Who may read the nested Ground Truth queue panel: the Extraction tab's
 * readers who review, approve or audit, and the legal reviewer who owns the
 * golden-case lane. Reading is all the panel does; every claim and append
 * stays on the lane-scoped commands with their own role checks.
 */
const GROUND_TRUTH_QUEUE_READ_ROLES = Object.freeze([
  "extraction_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin",
] as const satisfies readonly V07Role[]);

export type DurableGovernanceLegalReviewScope = Readonly<{
  actor: VerifiedActor;
  correlation_id: string;
}>;

export type DurableGroundTruthQueueProjection = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  persistence: "postgresql_required";
  governance_workflow: "ground_truth";
  entries: readonly GovernanceWorkQueueEntry[];
  content_included: false;
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;

export type DurableLegalReviewQueueProjection = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  persistence: "postgresql_required";
  governance_workflow: "legal_review";
  entries: readonly LegalReviewDurableRow[];
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;

export type DurableLegalTopicProjection = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  persistence: "postgresql_required";
  governance_workflow: "legal_review";
  readiness: LegalTopicReadiness;
  activation_allowed: false;
}>;

export type DurableLegalReviewActionResult = Readonly<{
  schema_version: typeof DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION;
  persistence: "postgresql_required";
  governance_workflow: "legal_review";
  receipt: GovernanceMutationReceipt;
  product_reachable_memory_fallback: false;
  activation_allowed: false;
}>;

/** The workspace is not case-scoped, so it enters the canonical transaction
 * with no case binding and its own correlation id. */
function legalReviewScope(scope: DurableGovernanceLegalReviewScope): DurableGovernanceOperationsScope {
  return Object.freeze({
    actor: scope.actor,
    case_id: null,
    correlation_id: scope.correlation_id,
  }) as unknown as DurableGovernanceOperationsScope;
}

const INTERNAL_REVIEWER_KEY_ROLES = Object.freeze([
  "extraction_reviewer",
  "fact_reviewer",
  "legal_reviewer",
  "parameter_verifier",
  "report_approver",
  "auditor",
  "break_glass_admin",
] as const satisfies readonly V07Role[]);

const CORE_TAB_READ = Object.freeze({
  Overview: "case",
  Payment: "payment",
  Documents: "documents",
  Extraction: "extraction",
  Facts: "facts",
  Analysis: "analysis",
  Report: "report",
  Audit: "audit",
} as const satisfies Partial<Record<DurableOperationsTab, InternalOpsReadKind>>);

const TAB_GOVERNANCE_WORKFLOW = Object.freeze({
  Extraction: "ground_truth",
  Legal: "legal_reconciliation",
  Parameters: "parameter_approval",
  Rules: "rulespec_approval",
} as const satisfies Partial<Record<DurableOperationsTab, GovernanceWorkflowKind>>);

const TAB_READ_ROLES = Object.freeze({
  Overview: ["intake_operator", "extraction_reviewer", "fact_reviewer", "legal_reviewer", "parameter_verifier", "report_approver", "auditor", "scoped_background_worker", "break_glass_admin"],
  Payment: ["intake_operator", "report_approver", "auditor", "break_glass_admin"],
  Documents: ["intake_operator", "extraction_reviewer", "fact_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Extraction: ["extraction_reviewer", "fact_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Facts: ["fact_reviewer", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Legal: ["legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Parameters: ["parameter_verifier", "legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Rules: ["legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Analysis: ["legal_reviewer", "report_approver", "auditor", "scoped_background_worker", "break_glass_admin"],
  Report: ["legal_reviewer", "report_approver", "auditor", "break_glass_admin"],
  Audit: ["auditor", "break_glass_admin"],
} as const satisfies Readonly<Record<DurableOperationsTab, readonly V07Role[]>>);

export interface DurableGovernanceOperationsApplication extends InternalOpsApplicationPort {
  proof(): DurableGovernanceOperationsProof;
  readTab(input: DurableGovernanceOperationsScope & Readonly<{
    tab: DurableOperationsTab;
    aggregate_references?: readonly GovernanceAggregateReference[];
  }>): Promise<DurableOperationsTabProjection>;
  readReviewerTrust(input: DurableGovernanceOperationsScope & Readonly<{
    aggregate_references: readonly GovernanceAggregateReference[];
  }>): Promise<DurableReviewerTrustProjection>;
  claimPendingWork(input: DurableGovernanceOperationsScope & Readonly<{
    lane: DurableGovernanceWorkLane;
    now: string;
    lease_seconds: number;
  }>): Promise<DurableGovernanceClaimResult>;
  executeGovernance(
    scope: DurableGovernanceOperationsScope,
    command: DurableGovernanceCommand,
  ): Promise<DurableGovernanceCommandResult>;
  readLegalReviewQueue(input: DurableGovernanceLegalReviewScope & Readonly<{
    limit: number;
  }>): Promise<DurableLegalReviewQueueProjection>;
  readLegalReviewTopics(input: DurableGovernanceLegalReviewScope): Promise<DurableLegalTopicProjection>;
  readGroundTruthQueue(input: DurableGovernanceLegalReviewScope & Readonly<{
    limit: number;
  }>): Promise<DurableGroundTruthQueueProjection>;
  submitLegalReviewAction(input: DurableGovernanceLegalReviewScope & Readonly<{
    packet: LegalReviewPacket;
    action: LegalReviewAction;
    applied_actions?: readonly LegalReviewAction[];
    superseded_by_packet_id?: string | null;
    idempotency_key: string;
    occurred_at: string;
  }>): Promise<DurableLegalReviewActionResult>;
}

export type DurableGovernanceOperationsRouteAdapter = DurableProductRouteServiceAdapter<
  DurableGovernanceOperationsApplication
>;

class PostgresDurableGovernanceOperationsApplication implements DurableGovernanceOperationsApplication {
  readonly #base: InternalOpsApplicationPort;
  readonly #context: DurableProductRouteContext;
  readonly #now: () => string;

  constructor(input: Readonly<{
    base: InternalOpsApplicationPort;
    context: DurableProductRouteContext;
    now: () => string;
  }>) {
    this.#base = input.base;
    this.#context = input.context;
    this.#now = input.now;
  }

  proof(): DurableGovernanceOperationsProof {
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      persistence: "postgresql_required",
      stable_operations_async: true,
      canonical_transaction_contexts: 1,
      product_reachable_memory_fallbacks: 0,
      durable_governance_replacements_wired: 4,
      operations_tabs: DURABLE_OPERATIONS_TABS,
      activation_allowed: false,
    });
  }

  read(actor: VerifiedActor, kind: InternalOpsReadKind, caseId: string | null): Promise<OpsReadProjection> {
    return this.#base.read(actor, kind, caseId);
  }

  mutate(actor: VerifiedActor, request: unknown, correlationId: string): Promise<InternalOpsCommandResult> {
    return this.#base.mutate(actor, request, correlationId);
  }

  async readTab(input: DurableGovernanceOperationsScope & Readonly<{
    tab: DurableOperationsTab;
    aggregate_references?: readonly GovernanceAggregateReference[];
  }>): Promise<DurableOperationsTabProjection> {
    if (!DURABLE_OPERATIONS_TABS.includes(input.tab)) {
      throw new Error("DURABLE_GOVERNANCE_OPERATIONS_TAB_INVALID");
    }
    this.#assertScope(input, TAB_READ_ROLES[input.tab]);
    const references = validateReferences(input.aggregate_references ?? []);
    const coreRead = CORE_TAB_READ[input.tab as keyof typeof CORE_TAB_READ];
    const workflow = TAB_GOVERNANCE_WORKFLOW[input.tab as keyof typeof TAB_GOVERNANCE_WORKFLOW] ?? null;
    if (workflow === null && references.length > 0) {
      throw new Error("DURABLE_GOVERNANCE_TAB_REFERENCES_FORBIDDEN");
    }

    const coreProjection = coreRead
      ? await this.#base.read(input.actor, coreRead, input.case_id)
      : null;
    const snapshots = workflow === null
      ? Object.freeze([]) as readonly GovernanceAggregateSnapshot[]
      : await this.#withGovernance(input, async (application) => {
          const repository = repositoryForWorkflow(application, workflow);
          const result: GovernanceAggregateSnapshot[] = [];
          for (const reference of references) {
            result.push(await repository.readCurrent(
              workflow,
              reference.aggregate_id,
              reference.aggregate_version,
            ));
          }
          return Object.freeze(result);
        });

    const source = coreProjection === null
      ? "durable_governance_postgres" as const
      : workflow === null
        ? "canonical_case_postgres" as const
        : "canonical_case_and_durable_governance_postgres" as const;
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      tab: input.tab,
      case_id: input.case_id,
      persistence: "postgresql_required",
      source,
      core_projection: coreProjection,
      governance_workflow: workflow,
      governance_snapshots: snapshots,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  async readReviewerTrust(input: DurableGovernanceOperationsScope & Readonly<{
    aggregate_references: readonly GovernanceAggregateReference[];
  }>): Promise<DurableReviewerTrustProjection> {
    this.#assertScope(input, ["auditor", "break_glass_admin"]);
    const references = validateReferences(input.aggregate_references);
    const snapshots = await this.#withGovernance(input, async (application) => {
      const result: GovernanceAggregateSnapshot[] = [];
      for (const reference of references) {
        result.push(await application.reviewer_trust.readCurrent(
          "reviewer_trust",
          reference.aggregate_id,
          reference.aggregate_version,
        ));
      }
      return Object.freeze(result);
    });
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      persistence: "postgresql_required",
      governance_workflow: "reviewer_trust",
      governance_snapshots: snapshots,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  /**
   * Nested Legal Review workspace. It hangs off the existing protected
   * operations surface rather than adding a top-level tab, so the established
   * navigation contract is untouched. Review packets belong to the internal
   * governance surface rather than to a case, so the scope carries no case
   * binding; every other control — verified server-side actor, tenant, role and
   * the canonical transaction — is the same as every other operation here.
   */
  async readLegalReviewQueue(input: DurableGovernanceLegalReviewScope & Readonly<{
    limit: number;
  }>): Promise<DurableLegalReviewQueueProjection> {
    this.#assertLegalReviewScope(input, LEGAL_REVIEW_READ_ROLES);
    const entries = await this.#withGovernance(
      legalReviewScope(input),
      (application) => application.legal_review.listQueue(input.limit),
    );
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      persistence: "postgresql_required",
      governance_workflow: "legal_review",
      entries,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  /**
   * Submits one reviewer action. Admissibility, revision compare-and-swap,
   * attestation and replay conflict are all decided by the canonical adapter
   * and its pure workflow; nothing is re-decided or relaxed here.
   */
  async submitLegalReviewAction(input: DurableGovernanceLegalReviewScope & Readonly<{
    packet: LegalReviewPacket;
    action: LegalReviewAction;
    applied_actions?: readonly LegalReviewAction[];
    superseded_by_packet_id?: string | null;
    idempotency_key: string;
    occurred_at: string;
  }>): Promise<DurableLegalReviewActionResult> {
    this.#assertLegalReviewScope(input, LEGAL_REVIEW_ACTION_ROLES);
    const receipt = await this.#withGovernance(
      legalReviewScope(input),
      (application) => application.legal_review.appendAction({
        packet: input.packet,
        action: input.action,
        applied_actions: input.applied_actions ?? [],
        superseded_by_packet_id: input.superseded_by_packet_id ?? null,
        metadata: Object.freeze({
          idempotency_key: input.idempotency_key,
          occurred_at: input.occurred_at,
        }),
      }),
    );
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      persistence: "postgresql_required",
      governance_workflow: "legal_review",
      receipt,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  /**
   * Seven-topic readiness derived from the durable queue. Gate evidence comes
   * only from stored packets; every other gate stays blocked because no
   * attestation, rule approval or locked ground truth exists.
   */
  async readLegalReviewTopics(input: DurableGovernanceLegalReviewScope): Promise<DurableLegalTopicProjection> {
    this.#assertLegalReviewScope(input, LEGAL_REVIEW_READ_ROLES);
    const entries = await this.#withGovernance(
      legalReviewScope(input),
      (application) => application.legal_review.listQueue(500),
    );
    const byTopic = new Map<string, { approved: number; period: number; scope: number }>();
    for (const entry of entries) {
      if (entry.topic === null) continue;
      const observed = byTopic.get(entry.topic) ?? { approved: 0, period: 0, scope: 0 };
      if (entry.state === "approved") observed.approved += 1;
      byTopic.set(entry.topic, observed);
    }
    const evidence: LegalTopicEvidence[] = [...byTopic.entries()].map(([topic, observed]) => ({
      topic: topic as LegalTopicEvidence["topic"],
      approved_packets: observed.approved,
      packets_with_known_period: observed.period,
      packets_with_declared_scope: observed.scope,
      dual_attested_parameters: 0,
      approved_not_activated_rulespecs: 0,
      locked_ground_truth_cases: 0,
    }));
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      persistence: "postgresql_required" as const,
      governance_workflow: "legal_review" as const,
      readiness: buildLegalTopicReadiness(evidence),
      activation_allowed: false as const,
    });
  }

  #assertLegalReviewScope(scope: DurableGovernanceLegalReviewScope, roles: readonly V07Role[]): void {
    if (!scope.actor || scope.actor.verified_server_side !== true || scope.actor.tenant_id === null
        || !ID.test(scope.correlation_id) || !roles.includes(scope.actor.role)) {
      throw new Error("DURABLE_GOVERNANCE_OPERATIONS_FORBIDDEN");
    }
  }

  /**
   * Nested Ground Truth queue panel: the durable annotation queue as a
   * projection, read through the list definer as the runtime role. Identity,
   * state, claimant and lease only — the definer never returns a payload and
   * the row schema is strict — so the panel is not a content path.
   */
  async readGroundTruthQueue(input: DurableGovernanceLegalReviewScope & Readonly<{
    limit: number;
  }>): Promise<DurableGroundTruthQueueProjection> {
    this.#assertLegalReviewScope(input, GROUND_TRUTH_QUEUE_READ_ROLES);
    const entries = await this.#withGovernance(
      legalReviewScope(input),
      (application) => application.work_queue.listQueue("ground_truth", input.limit),
    );
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      persistence: "postgresql_required",
      governance_workflow: "ground_truth",
      entries,
      content_included: false,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  async claimPendingWork(input: DurableGovernanceOperationsScope & Readonly<{
    lane: DurableGovernanceWorkLane;
    now: string;
    lease_seconds: number;
  }>): Promise<DurableGovernanceClaimResult> {
    const descriptor = DURABLE_GOVERNANCE_WORK_LANES[input.lane];
    if (!descriptor) throw new Error("DURABLE_GOVERNANCE_WORK_LANE_INVALID");
    this.#assertScope(input, [descriptor.actor_role]);
    const claim = await this.#withGovernance(input, (application) => application.work_queue.claim({
      workflow_kind: descriptor.workflow_kind,
      work_kind: descriptor.work_kind,
      claimant_id: input.actor.actor_id,
      reviewer_role: descriptor.reviewer_role,
      now: input.now,
      lease_seconds: input.lease_seconds,
    }));
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      lane: input.lane,
      claim,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  async executeGovernance(
    scope: DurableGovernanceOperationsScope,
    command: DurableGovernanceCommand,
  ): Promise<DurableGovernanceCommandResult> {
    this.#assertCommandActor(scope, command);
    const result = await this.#withGovernance(scope, (application) => executeCommand(
      application,
      scope.actor.actor_id,
      command,
    ));
    return Object.freeze({
      schema_version: DURABLE_GOVERNANCE_OPERATIONS_SCHEMA_VERSION,
      action: command.action,
      result,
      product_reachable_memory_fallback: false,
      activation_allowed: false,
    });
  }

  #assertCommandActor(scope: DurableGovernanceOperationsScope, command: DurableGovernanceCommand): void {
    const actor = scope.actor;
    const signedReviewerId = signedReviewerFor(command);
    switch (command.action) {
      case "reviewer_trust.organization.append":
      case "reviewer_trust.policy.append":
      case "reviewer_trust.reviewer.append":
        this.#assertScope(scope, ["break_glass_admin"]);
        return;
      case "reviewer_trust.key.revoke":
        this.#assertScope(scope, ["break_glass_admin"]);
        if (command.input.actor_id !== actor.actor_id) {
          throw new Error("DURABLE_GOVERNANCE_REVIEWER_BINDING_MISMATCH");
        }
        return;
      case "reviewer_trust.key_challenge.append": {
        const candidate = asRecord(command.candidate);
        const selfRotation = INTERNAL_REVIEWER_KEY_ROLES.includes(actor.role as (typeof INTERNAL_REVIEWER_KEY_ROLES)[number])
          && actor.actor_id === candidate.reviewer_id
          && candidate.replaces_key_id !== null;
        this.#assertScope(scope, selfRotation ? [actor.role] : ["break_glass_admin"]);
        return;
      }
      case "reviewer_trust.key.register":
        this.#assertScope(scope, INTERNAL_REVIEWER_KEY_ROLES);
        if (actor.actor_id !== command.input.challenge.reviewer_id) {
          throw new Error("DURABLE_GOVERNANCE_REVIEWER_BINDING_MISMATCH");
        }
        return;
      case "work.enqueue": {
        const work = governanceWorkEnqueueSchema.parse(command.input);
        const descriptor = Object.values(DURABLE_GOVERNANCE_WORK_LANES).find((candidate) => (
          candidate.workflow_kind === work.workflow_kind
          && candidate.work_kind === work.work_kind
        ));
        if (!descriptor || descriptor.reviewer_role !== work.required_role) {
          throw new Error("DURABLE_GOVERNANCE_WORK_LANE_BINDING_MISMATCH");
        }
        this.#assertScope(scope, ["scoped_background_worker"]);
        return;
      }
      case "legal_observation.import":
      case "historical_observations.import_exact_plan":
      case "parameter.candidate.import":
      case "rulespec.golden_case_set.import":
      case "rulespec.package.import":
        this.#assertScope(scope, ["scoped_background_worker"]);
        return;
      case "work.release": {
        const descriptor = DURABLE_GOVERNANCE_WORK_LANES[command.lane];
        this.#assertScope(scope, [descriptor.actor_role]);
        if (command.input.claimant_id !== actor.actor_id) {
          throw new Error("DURABLE_GOVERNANCE_REVIEWER_BINDING_MISMATCH");
        }
        return;
      }
      case "ground_truth.visual_eligibility.append":
      case "ground_truth.manifest.append":
        this.#assertScope(scope, ["extraction_reviewer"]);
        break;
      case "legal_observation.decide":
        this.#assertScope(scope, ["legal_reviewer"]);
        break;
      case "parameter.attestation.append":
        this.#assertScope(scope, ["parameter_verifier"]);
        break;
      case "rulespec.approval.append":
        this.#assertScope(scope, ["legal_reviewer"]);
        break;
      default:
        throw new Error("DURABLE_GOVERNANCE_COMMAND_INVALID");
    }
    if (signedReviewerId !== null && signedReviewerId !== actor.actor_id) {
      throw new Error("DURABLE_GOVERNANCE_REVIEWER_BINDING_MISMATCH");
    }
  }

  #assertScope(scope: DurableGovernanceOperationsScope, roles: readonly V07Role[]): void {
    if (!scope.actor || scope.actor.verified_server_side !== true || scope.actor.tenant_id === null
        || !ID.test(scope.case_id) || !ID.test(scope.correlation_id)
        || !roles.includes(scope.actor.role)
        || !actorScopePermits(scope.actor, scope.case_id, this.#now())) {
      throw new Error("DURABLE_GOVERNANCE_OPERATIONS_FORBIDDEN");
    }
  }

  #withGovernance<T>(
    scope: DurableGovernanceOperationsScope,
    operation: (application: DurableGovernanceApplication) => Promise<T>,
  ): Promise<T> {
    const tenantId = scope.actor.tenant_id;
    if (tenantId === null) return Promise.reject(new Error("DURABLE_GOVERNANCE_OPERATIONS_FORBIDDEN"));
    return this.#context.session_context.transaction({
      actor: scope.actor,
      audience: "operations",
      case_id: scope.case_id,
      correlation_id: scope.correlation_id,
    }, async (bundle) => {
      const application = createDurableGovernanceApplication(bundle.context, tenantId);
      if (application.persistence !== "postgresql_required"
          || application.product_reachable_memory_fallback !== false
          || application.activation_allowed !== false
          || application.durable_replacement_count !== 4
          || application.transaction_id !== bundle.context.transaction_id) {
        throw new Error("DURABLE_GOVERNANCE_APPLICATION_PROOF_INVALID");
      }
      return operation(application);
    });
  }
}

export function createDurableGovernanceOperationsRouteAdapter(input: Readonly<{
  context: DurableProductRouteContext;
  base: DurableProductRouteServiceAdapter<InternalOpsApplicationPort>;
  now?: () => string;
}>): DurableGovernanceOperationsRouteAdapter {
  if (!input.context || !input.base
      || input.base.proof_class !== "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE"
      || input.base.postgres !== input.context.postgres
      || input.base.product !== input.context.product
      || input.base.session_context !== input.context.session_context
      || typeof input.base.service?.read !== "function"
      || typeof input.base.service?.mutate !== "function") {
    throw new Error("DURABLE_GOVERNANCE_OPERATIONS_TRANSACTION_ROOT_MISMATCH");
  }
  const service = new PostgresDurableGovernanceOperationsApplication({
    base: input.base.service,
    context: input.context,
    now: input.now ?? (() => new Date().toISOString()),
  });
  return Object.freeze({
    service,
    postgres: input.context.postgres,
    product: input.context.product,
    session_context: input.context.session_context,
    proof_class: "POSTGRESQL_TRANSACTIONAL_ROUTE_SERVICE" as const,
  });
}

function validateReferences(input: readonly GovernanceAggregateReference[]): readonly GovernanceAggregateReference[] {
  if (input.length > 200) throw new Error("DURABLE_GOVERNANCE_TAB_REFERENCE_LIMIT");
  const references = input.map((reference) => Object.freeze({
    aggregate_id: governanceIdSchema.parse(reference.aggregate_id),
    aggregate_version: governanceVersionSchema.parse(reference.aggregate_version),
  })).sort((left, right) => (
    left.aggregate_id.localeCompare(right.aggregate_id, "en")
    || left.aggregate_version.localeCompare(right.aggregate_version, "en")
  ));
  const keys = references.map((reference) => `${reference.aggregate_id}\u0000${reference.aggregate_version}`);
  if (new Set(keys).size !== keys.length) throw new Error("DURABLE_GOVERNANCE_TAB_REFERENCE_DUPLICATE");
  return Object.freeze(references);
}

function repositoryForWorkflow(application: DurableGovernanceApplication, workflow: GovernanceWorkflowKind) {
  switch (workflow) {
    case "reviewer_trust": return application.reviewer_trust;
    case "ground_truth": return application.ground_truth;
    case "legal_reconciliation": return application.legal_reconciliation;
    case "parameter_approval": return application.parameters;
    case "rulespec_approval": return application.rulespec;
    case "legal_review": return application.legal_review;
  }
}

function signedReviewerFor(command: DurableGovernanceCommand): string | null {
  switch (command.action) {
    case "ground_truth.visual_eligibility.append":
      return command.input.verification.reviewer_id === command.input.decision.reviewer_id
        ? command.input.verification.reviewer_id
        : "__binding_mismatch__";
    case "ground_truth.manifest.append":
      return command.input.verification?.reviewer_id ?? null;
    case "legal_observation.decide":
      return command.input.verification.reviewer_id === command.input.decision.reviewer_id
        ? command.input.verification.reviewer_id
        : "__binding_mismatch__";
    case "parameter.attestation.append":
      return command.input.verification.reviewer_id === command.input.attestation.reviewer_id
        ? command.input.verification.reviewer_id
        : "__binding_mismatch__";
    case "rulespec.approval.append":
      return command.input.verification.reviewer_id === command.input.approval.reviewer_id
        ? command.input.verification.reviewer_id
        : "__binding_mismatch__";
    default:
      return null;
  }
}

function executeCommand(
  application: DurableGovernanceApplication,
  actorId: string,
  command: DurableGovernanceCommand,
): Promise<GovernanceMutationReceipt | HistoricalObservationImportReceipt> {
  switch (command.action) {
    case "reviewer_trust.organization.append":
      return application.reviewer_trust.appendOrganization(command.candidate, actorId, command.metadata);
    case "reviewer_trust.policy.append":
      return application.reviewer_trust.appendPolicy(command.candidate, actorId, command.metadata);
    case "reviewer_trust.reviewer.append":
      return application.reviewer_trust.appendReviewer(command.candidate, actorId, command.metadata);
    case "reviewer_trust.key_challenge.append":
      return application.reviewer_trust.appendKeyChallenge(command.candidate, actorId, command.metadata);
    case "reviewer_trust.key.register":
      return application.reviewer_trust.registerProvenKey(command.input);
    case "reviewer_trust.key.revoke":
      return application.reviewer_trust.revokeKey(command.input);
    case "work.enqueue":
      return application.work_queue.enqueue(command.input);
    case "work.release":
      return application.work_queue.release(command.input);
    case "ground_truth.visual_eligibility.append":
      return application.ground_truth.appendVisualEligibility(command.input);
    case "ground_truth.manifest.append":
      return application.ground_truth.appendManifest(command.input);
    case "legal_observation.import":
      return application.legal_reconciliation.importObservation(command.candidate, command.metadata);
    case "legal_observation.decide":
      return application.legal_reconciliation.decideObservation(command.input);
    case "historical_observations.import_exact_plan":
      return application.historical_observations.importExactPlan(command.plan, command.imported_at);
    case "parameter.candidate.import":
      return application.parameters.importCandidate(command.candidate, command.metadata);
    case "parameter.attestation.append":
      return application.parameters.appendAttestation(command.input);
    case "rulespec.golden_case_set.import":
      return application.rulespec.importGoldenCaseSet(command.candidate, command.metadata);
    case "rulespec.package.import":
      return application.rulespec.importRuleSpec(command.candidate, command.metadata);
    case "rulespec.approval.append":
      return application.rulespec.appendApproval(command.input);
    default:
      throw new Error("DURABLE_GOVERNANCE_COMMAND_INVALID");
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : Object.freeze({});
}
