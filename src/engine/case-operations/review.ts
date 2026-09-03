import type {
  CanonicalHashPort,
  CaseReviewDecision,
  CaseReviewPort,
  DeterministicClockPort,
  DeterministicIdPort,
} from "../wave3/contracts.ts";
import { immutable } from "./canonical.ts";
import type { ReviewInvalidator } from "./lifecycle.ts";

export const CASE_REVIEW_TASK_SCHEMA = "tivdoc-case-review-task-v0.6.0" as const;
export const CASE_REVIEW_DECISION_SCHEMA = "tivdoc-case-review-decision-v0.6.0" as const;

export type CaseReviewTask = Readonly<{
  schema_version: typeof CASE_REVIEW_TASK_SCHEMA;
  task_id: string;
  task_revision: number;
  task_kind: CaseReviewDecision["task_kind"];
  case_id: string;
  input_sha256: string;
  output_sha256: string;
  created_at: string;
  supersedes_task_id: string | null;
  task_sha256: string;
}>;

export type CaseReviewReceipt = Readonly<{
  schema_version: "tivdoc-case-review-receipt-v0.6.0";
  task_id: string;
  task_revision: number;
  decision_sha256: string;
  prior_receipt_sha256: string | null;
  receipt_sha256: string;
}>;

export type ReviewInvalidation = Readonly<{
  schema_version: "tivdoc-case-review-invalidation-v0.6.0";
  case_id: string;
  invalidation_revision: number;
  invalidated_at: string;
  reason_code: string;
  mutation_sha256: string;
  invalidation_sha256: string;
}>;

export class CaseReviewError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CaseReviewError";
  }
}

const DECISION_KEYS = [
  "decided_at",
  "decision",
  "input_sha256",
  "output_sha256",
  "reason",
  "reviewer_id",
  "reviewer_role",
  "schema_version",
  "task_id",
  "task_kind",
] as const;

type StoredTask = {
  task: CaseReviewTask;
  decision: CaseReviewDecision | null;
  receipt: CaseReviewReceipt | null;
  invalidated: boolean;
};

export class InMemoryCaseReviewService implements CaseReviewPort, ReviewInvalidator {
  readonly #tasks = new Map<string, StoredTask>();
  readonly #caseTaskIds = new Map<string, string[]>();
  readonly #invalidations = new Map<string, ReviewInvalidation[]>();
  readonly #decisionReceipts = new Map<string, CaseReviewReceipt>();
  readonly #clock: DeterministicClockPort;
  readonly #ids: DeterministicIdPort;
  readonly #hash: CanonicalHashPort;

  constructor(input: Readonly<{ clock: DeterministicClockPort; ids: DeterministicIdPort; hash: CanonicalHashPort }>) {
    this.#clock = input.clock;
    this.#ids = input.ids;
    this.#hash = input.hash;
  }

  createTask(input: Readonly<{
    case_id: string;
    task_kind: CaseReviewTask["task_kind"];
    input_sha256: string;
    output_sha256: string;
  }>): CaseReviewTask {
    assertHash(input.input_sha256);
    assertHash(input.output_sha256);
    const prior = this.tasksForCase(input.case_id).filter((task) => task.task_kind === input.task_kind).at(-1) ?? null;
    if (prior && prior.input_sha256 === input.input_sha256 && prior.output_sha256 === input.output_sha256 && !this.#tasks.get(prior.task_id)!.invalidated) {
      return prior;
    }
    const revision = (prior?.task_revision ?? 0) + 1;
    const unsigned = {
      schema_version: CASE_REVIEW_TASK_SCHEMA,
      task_revision: revision,
      task_kind: input.task_kind,
      case_id: input.case_id,
      input_sha256: input.input_sha256,
      output_sha256: input.output_sha256,
      created_at: this.#clock.now(),
      supersedes_task_id: prior?.task_id ?? null,
    };
    const taskSha = this.#hash.hashCanonical(unsigned);
    const task = immutable({
      ...unsigned,
      task_id: this.#ids.derive("case-review-task", taskSha),
      task_sha256: taskSha,
    });
    this.#tasks.set(task.task_id, { task, decision: null, receipt: null, invalidated: false });
    this.#caseTaskIds.set(input.case_id, [...(this.#caseTaskIds.get(input.case_id) ?? []), task.task_id]);
    return task;
  }

  async decide(decision: CaseReviewDecision): Promise<Readonly<{ task_id: string; revision: number; receipt_sha256: string }>> {
    const keys = Object.keys(decision).sort();
    if (keys.length !== DECISION_KEYS.length || keys.some((key, index) => key !== [...DECISION_KEYS].sort()[index])) {
      throw new CaseReviewError("review_decision_unknown_or_missing_field");
    }
    if (decision.schema_version !== CASE_REVIEW_DECISION_SCHEMA) throw new CaseReviewError("review_decision_schema_mismatch");
    const stored = this.#tasks.get(decision.task_id);
    if (!stored) throw new CaseReviewError("review_task_not_found");
    if (stored.invalidated) throw new CaseReviewError("review_task_invalidated");
    if (decision.task_kind !== stored.task.task_kind) throw new CaseReviewError("review_task_kind_mismatch");
    if (decision.input_sha256 !== stored.task.input_sha256 || decision.output_sha256 !== stored.task.output_sha256) {
      throw new CaseReviewError("review_hash_binding_mismatch");
    }
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(decision.decided_at)) {
      throw new CaseReviewError("review_decision_timestamp_invalid");
    }
    const decisionSha = this.#hash.hashCanonical(decision);
    const priorReceipt = this.#decisionReceipts.get(decisionSha);
    if (priorReceipt) return immutable({ task_id: priorReceipt.task_id, revision: priorReceipt.task_revision, receipt_sha256: priorReceipt.receipt_sha256 });
    if (stored.decision !== null) throw new CaseReviewError("review_task_already_decided");
    const unsigned = {
      schema_version: "tivdoc-case-review-receipt-v0.6.0" as const,
      task_id: decision.task_id,
      task_revision: stored.task.task_revision,
      decision_sha256: decisionSha,
      prior_receipt_sha256: this.#latestReceiptSha(stored.task.case_id),
    };
    const receipt = immutable({ ...unsigned, receipt_sha256: this.#hash.hashCanonical(unsigned) });
    stored.decision = immutable({ ...decision });
    stored.receipt = receipt;
    this.#decisionReceipts.set(decisionSha, receipt);
    return immutable({ task_id: receipt.task_id, revision: receipt.task_revision, receipt_sha256: receipt.receipt_sha256 });
  }

  async isReportExportEligible(caseId: string, reportSha256: string): Promise<boolean> {
    assertHash(reportSha256);
    const candidates = (this.#caseTaskIds.get(caseId) ?? [])
      .map((taskId) => this.#tasks.get(taskId)!)
      .filter((stored) => stored.task.task_kind === "report_approval" && stored.task.output_sha256 === reportSha256);
    const current = candidates.at(-1);
    return Boolean(current && !current.invalidated && current.decision?.decision === "approved" && current.receipt !== null);
  }

  invalidateCase(caseId: string, invalidatedAt: string, reasonCode: string, mutationSha256: string): void {
    assertHash(mutationSha256);
    const prior = this.#invalidations.get(caseId) ?? [];
    const unsigned = {
      schema_version: "tivdoc-case-review-invalidation-v0.6.0" as const,
      case_id: caseId,
      invalidation_revision: prior.length + 1,
      invalidated_at: invalidatedAt,
      reason_code: reasonCode,
      mutation_sha256: mutationSha256,
      prior_invalidation_sha256: prior.at(-1)?.invalidation_sha256 ?? null,
    };
    const event = immutable({ ...unsigned, invalidation_sha256: this.#hash.hashCanonical(unsigned) });
    this.#invalidations.set(caseId, [...prior, event]);
    for (const taskId of this.#caseTaskIds.get(caseId) ?? []) this.#tasks.get(taskId)!.invalidated = true;
  }

  tasksForCase(caseId: string): readonly CaseReviewTask[] {
    return immutable((this.#caseTaskIds.get(caseId) ?? []).map((taskId) => ({ ...this.#tasks.get(taskId)!.task })));
  }

  decisionsForCase(caseId: string): readonly CaseReviewDecision[] {
    return immutable((this.#caseTaskIds.get(caseId) ?? [])
      .map((taskId) => this.#tasks.get(taskId)!.decision)
      .filter((decision): decision is CaseReviewDecision => decision !== null)
      .map((decision) => ({ ...decision })));
  }

  invalidationsForCase(caseId: string): readonly ReviewInvalidation[] {
    return immutable((this.#invalidations.get(caseId) ?? []).map((event) => ({ ...event })));
  }

  receiptForTask(taskId: string): CaseReviewReceipt | null {
    const receipt = this.#tasks.get(taskId)?.receipt;
    return receipt ? immutable({ ...receipt }) : null;
  }

  verifyReportApprovalReceipt(caseId: string, reportSha256: string, receiptSha256: string): boolean {
    return (this.#caseTaskIds.get(caseId) ?? []).some((taskId) => {
      const stored = this.#tasks.get(taskId)!;
      return stored.task.task_kind === "report_approval"
        && stored.task.output_sha256 === reportSha256
        && stored.decision?.decision === "approved"
        && !stored.invalidated
        && stored.receipt?.receipt_sha256 === receiptSha256;
    });
  }

  #latestReceiptSha(caseId: string): string | null {
    const receipts = (this.#caseTaskIds.get(caseId) ?? []).map((taskId) => this.#tasks.get(taskId)!.receipt).filter(Boolean) as CaseReviewReceipt[];
    return receipts.at(-1)?.receipt_sha256 ?? null;
  }
}

export class ManualExportEligibilityService {
  readonly #cases: Readonly<{ get(caseId: string): Promise<Readonly<{ state: string }> | null> }>;
  readonly #reviews: Pick<CaseReviewPort, "isReportExportEligible">;

  constructor(
    cases: Readonly<{ get(caseId: string): Promise<Readonly<{ state: string }> | null> }>,
    reviews: Pick<CaseReviewPort, "isReportExportEligible">,
  ) {
    this.#cases = cases;
    this.#reviews = reviews;
  }

  async isEligible(caseId: string, reportSha256: string): Promise<boolean> {
    const caseState = await this.#cases.get(caseId);
    return caseState?.state === "report_ready" && await this.#reviews.isReportExportEligible(caseId, reportSha256);
  }
}

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new CaseReviewError("review_hash_invalid");
}
