import { createHash } from "node:crypto";
import { canonicalSha256 } from "../../../engine/rule-runtime/canonical";
import type { FactPath } from "../../../engine/facts/fact-paths";
import type {
  ClarificationFactState,
  ClarificationOrigin,
  ConsentRevision,
  CustomerClarificationTask,
  DeclaredFactCandidate,
  LegalInputRequirement,
  PortalAuditReceipt,
  PortalCaseRecord,
  PortalClockPort,
  PortalRuntimeMode,
  PrivacyRequestKind,
  PrivacyRequestRevision,
  ReportAccessGrant,
  StoredReportEdition,
  UploadSession,
  VerifiedProductEvidence,
} from "./contracts";
import { PortalError } from "./contracts";
import type { CustomerPortalRepositoryPort } from "./repository.ts";

type Invite = Readonly<{
  invite_id: string;
  case_id: string;
  owner_actor_id: string;
  audience: string;
  token_sha256: string;
  expires_at: string;
  accepted_at: string | null;
}>;

type IdempotencyRecord<T> = Readonly<{ command_sha256: string; result: T }>;

const PROMPTS_HE: Readonly<Record<FactPath, string>> = Object.freeze({
  "employment.start_date": "מהו תאריך תחילת העבודה לפי ידיעתך?",
  "employment.end_date": "האם העבודה הסתיימה, ואם כן באיזה תאריך?",
  "compensation.salary_type": "כיצד הוגדר אופן תשלום השכר שלך?",
  "compensation.base_monthly_salary": "מהו שכר הבסיס החודשי שהוצהר בפניך?",
  "compensation.hourly_rate": "מהו השכר השעתי שהוצהר בפניך?",
  "compensation.gross_salary": "מהו השכר ברוטו המוצהר לתקופה?",
  "compensation.net_salary": "מהו השכר נטו המוצהר לתקופה?",
  "work.regular_hours": "כמה שעות רגילות עבדת בתקופה?",
  "work.overtime_hours": "כמה שעות נוספות עבדת בתקופה?",
  "work.overtime_125_hours": "כמה שעות סומנו אצלך כשעות נוספות מסוג 125%?",
  "work.overtime_150_hours": "כמה שעות סומנו אצלך כשעות נוספות מסוג 150%?",
  "work.workdays": "באילו ימים עבדת בדרך כלל?",
  "work.breaks": "מה היה משך ההפסקה המקובל בכל משמרת?",
  "pension.base_salary": "מהו בסיס השכר שנמסר לך לצורך ההפרשות?",
  "pension.contributions": "אילו הפרשות לפנסיה מופיעות במידע שבידך?",
  "pension.severance_contribution": "איזו הפרשה לפיצויים מופיעה במידע שבידך?",
  "leave.vacation_balance": "מהי יתרת החופשה המוצהרת?",
  "leave.sick_balance": "מהי יתרת המחלה המוצהרת?",
  "travel.reimbursement": "איזה החזר נסיעות הוצהר או שולם בתקופה?",
  "convalescence.payment": "איזה תשלום הבראה הוצהר או שולם בתקופה?",
  "documents.period": "לאיזו תקופה מתייחס המסמך?",
});

export class SyntheticPortalRepository implements CustomerPortalRepositoryPort {
  private readonly clock: PortalClockPort;
  private readonly cases = new Map<string, PortalCaseRecord>();
  private readonly tasks = new Map<string, CustomerClarificationTask[]>();
  private readonly candidates = new Map<string, DeclaredFactCandidate[]>();
  private readonly evidence = new Map<string, VerifiedProductEvidence[]>();
  private readonly reports = new Map<string, StoredReportEdition[]>();
  private readonly artifacts = new Map<string, Uint8Array>();
  private readonly consents = new Map<string, ConsentRevision[]>();
  private readonly privacyRequests = new Map<string, PrivacyRequestRevision[]>();
  private readonly invites = new Map<string, Invite>();
  private readonly uploads = new Map<string, UploadSession>();
  private readonly reportGrants = new Map<string, ReportAccessGrant>();
  private readonly audit: PortalAuditReceipt[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord<unknown>>();

  constructor(clock: PortalClockPort, mode: PortalRuntimeMode) {
    this.clock = clock;
    if (mode === "production") throw new PortalError("TEST_ADAPTER_FORBIDDEN_IN_PRODUCTION");
  }

  seedCase(record: PortalCaseRecord): void {
    if (this.cases.has(record.case_id)) throw new PortalError("SYNTHETIC_CASE_COLLISION");
    this.cases.set(record.case_id, clone(record));
  }

  seedProductEvidence(record: VerifiedProductEvidence): void {
    this.evidence.set(record.case_id, [...(this.evidence.get(record.case_id) ?? []), clone(record)]);
  }

  seedReport(record: StoredReportEdition, bytes: Uint8Array): void {
    if (bytes.byteLength < 1 || createHash("sha256").update(bytes).digest("hex") !== record.artifact_sha256) {
      throw new PortalError("ARTIFACT_HASH_MISMATCH");
    }
    this.reports.set(record.case_id, [...(this.reports.get(record.case_id) ?? []), clone(record)]);
    this.artifacts.set(record.object_version_id, Uint8Array.from(bytes));
  }

  recordSyntheticLifecycleTransition(
    caseId: string,
    actorId: string,
    lifecycleState: PortalCaseRecord["lifecycle_state"],
    blockerCodes: readonly string[],
    mutationSha256: string,
  ): void {
    const current = this.cases.get(caseId);
    if (!current) throw new PortalError("PORTAL_NOT_FOUND");
    const revision = current.revision + 1;
    this.cases.set(caseId, Object.freeze({
      ...current,
      revision,
      lifecycle_state: lifecycleState,
      lifecycle_history: Object.freeze([...current.lifecycle_history, Object.freeze({ revision, lifecycle_state: lifecycleState, occurred_at: this.clock.now() })]),
      blocker_codes: Object.freeze([...new Set(blockerCodes)].sort()),
    }));
    if (lifecycleState === "release_hold") this.invalidateReleasedReports(caseId, mutationSha256);
    this.appendAudit(caseId, actorId, `synthetic_lifecycle_${lifecycleState}`, mutationSha256);
  }

  case(caseId: string): PortalCaseRecord | null { return clone(this.cases.get(caseId) ?? null); }
  tasksForCase(caseId: string): readonly CustomerClarificationTask[] { return clone(this.tasks.get(caseId) ?? []); }
  reportsForCase(caseId: string): readonly StoredReportEdition[] { return clone(this.reports.get(caseId) ?? []); }
  evidenceForCase(caseId: string): readonly VerifiedProductEvidence[] { return clone(this.evidence.get(caseId) ?? []); }
  consentHistory(caseId: string): readonly ConsentRevision[] { return clone(this.consents.get(caseId) ?? []); }
  privacyHistory(caseId: string): readonly PrivacyRequestRevision[] { return clone(this.privacyRequests.get(caseId) ?? []); }
  auditHistory(caseId: string): readonly PortalAuditReceipt[] { return clone(this.audit.filter((event) => event.case_id === caseId)); }
  declaredCandidates(caseId: string): readonly DeclaredFactCandidate[] { return clone(this.candidates.get(caseId) ?? []); }

  createClarifications(caseId: string, facts: readonly ClarificationFactState[], requirements: readonly LegalInputRequirement[], originOverride: ClarificationOrigin | null = null): readonly CustomerClarificationTask[] {
    const requested = [
      ...facts.map((fact) => ({
        fact_path: fact.fact_path,
        origin: (originOverride ?? (fact.status === "missing" ? "missing_fact" : "conflicted_fact")) as ClarificationOrigin,
        dependency_sha256: fact.state_sha256,
        conflicting_fact_ids: fact.status === "conflicted" ? fact.fact_ids : [],
      })),
      ...requirements.map((requirement) => ({
        fact_path: requirement.fact_path,
        origin: (originOverride ?? "legal_input_requirement") as ClarificationOrigin,
        dependency_sha256: requirement.requirement_sha256,
        conflicting_fact_ids: [] as readonly string[],
      })),
    ].sort((left, right) => `${left.fact_path}:${left.origin}`.localeCompare(`${right.fact_path}:${right.origin}`));
    const history = [...(this.tasks.get(caseId) ?? [])];
    const created: CustomerClarificationTask[] = [];
    for (const item of requested) {
      const prior = history.filter((task) => task.fact_path === item.fact_path && task.origin === item.origin).at(-1) ?? null;
      if (prior?.dependency_sha256 === item.dependency_sha256 && prior.status !== "invalidated") {
        created.push(prior);
        continue;
      }
      if (prior && prior.status !== "invalidated") history[history.indexOf(prior)] = Object.freeze({ ...prior, status: "invalidated" });
      const unsigned = {
        case_id: caseId,
        fact_path: item.fact_path,
        origin: item.origin,
        question_code: `portal.fact.${item.fact_path}`,
        question_version: (prior?.question_version ?? 0) + 1,
        prompt_he: PROMPTS_HE[item.fact_path],
        dependency_sha256: item.dependency_sha256,
        conflicting_fact_ids: [...item.conflicting_fact_ids].sort(),
        status: "open" as const,
        requires_human_review: true as const,
      };
      const taskSha = canonicalSha256(unsigned);
      const task = Object.freeze({ ...unsigned, task_id: `clarification:${taskSha}`, task_sha256: taskSha });
      history.push(task);
      created.push(task);
    }
    this.tasks.set(caseId, history);
    return clone(created);
  }

  recordAnswer(input: Readonly<{
    actor_id: string;
    case_id: string;
    task_id: string;
    question_version: number;
    value: unknown;
    explicit_confirmation: true;
    consent_version: string;
    terms_version: string;
    idempotency_key: string;
  }>): Readonly<{ candidate: DeclaredFactCandidate; idempotent_replay: boolean }> {
    if (input.explicit_confirmation !== true) throw new PortalError("EXPLICIT_CONFIRMATION_REQUIRED");
    const commandSha = canonicalSha256(input);
    const idempotencyId = `${input.case_id}:clarification-answer:${input.idempotency_key}`;
    const replay = this.idempotency.get(idempotencyId) as IdempotencyRecord<Readonly<{ candidate: DeclaredFactCandidate; idempotent_replay: boolean }>> | undefined;
    if (replay) {
      if (replay.command_sha256 !== commandSha) throw new PortalError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
      return clone({ ...replay.result, idempotent_replay: true });
    }
    const taskHistory = this.tasks.get(input.case_id) ?? [];
    const task = taskHistory.find((candidate) => candidate.task_id === input.task_id);
    if (!task || task.status === "invalidated" || task.question_version !== input.question_version) throw new PortalError("PORTAL_NOT_FOUND");
    const consent = this.consents.get(input.case_id)?.at(-1);
    if (!consent?.granted || consent.consent_version !== input.consent_version || consent.terms_version !== input.terms_version) {
      throw new PortalError("CONSENT_VERSION_MISMATCH");
    }
    const prior = (this.candidates.get(input.case_id) ?? []).filter((candidate) => candidate.fact_path === task.fact_path).at(-1) ?? null;
    const answerId = `answer:${canonicalSha256({ task_id: task.task_id, revision: (prior?.revision ?? 0) + 1, value: input.value })}`;
    const unsigned = {
      candidate_id: `declared-candidate:${canonicalSha256({ answer_id: answerId, fact_path: task.fact_path })}`,
      case_id: input.case_id,
      fact_path: task.fact_path,
      revision: (prior?.revision ?? 0) + 1,
      value: clone(input.value),
      status: "candidate" as const,
      provenance: {
        source_type: "declared" as const,
        source_reference: {
          kind: "portal_clarification_answer" as const,
          answer_id: answerId,
          question_id: task.task_id,
          question_version: task.question_version,
          consent_version: input.consent_version,
          terms_version: input.terms_version,
          explicit_confirmation: true as const,
        },
      },
      conflicting_documented_fact_ids: [...task.conflicting_fact_ids],
      requires_human_review: true as const,
    };
    const candidate = Object.freeze({ ...unsigned, candidate_sha256: canonicalSha256(unsigned) });
    this.candidates.set(input.case_id, [...(this.candidates.get(input.case_id) ?? []), candidate]);
    const taskIndex = taskHistory.indexOf(task);
    taskHistory[taskIndex] = Object.freeze({ ...task, status: "answered" });
    this.tasks.set(input.case_id, taskHistory);
    this.invalidateReleasedReports(input.case_id, candidate.candidate_sha256);
    const result = Object.freeze({ candidate, idempotent_replay: false });
    this.idempotency.set(idempotencyId, { command_sha256: commandSha, result });
    this.appendAudit(input.case_id, input.actor_id, "clarification_answer_recorded", candidate.candidate_sha256);
    return clone(result);
  }

  recordConsent(input: Readonly<{ actor_id: string; case_id: string; consent_version: string; terms_version: string; granted: boolean; idempotency_key: string }>): Readonly<{ consent: ConsentRevision; idempotent_replay: boolean }> {
    return this.idempotent(`${input.case_id}:consent:${input.idempotency_key}`, input, () => {
      const revision = (this.consents.get(input.case_id)?.at(-1)?.revision ?? 0) + 1;
      const unsigned = { consent_id: `consent:${input.case_id}`, case_id: input.case_id, revision, consent_version: input.consent_version, terms_version: input.terms_version, granted: input.granted, occurred_at: this.clock.now() };
      const consent = Object.freeze({ ...unsigned, receipt_sha256: canonicalSha256(unsigned) });
      this.consents.set(input.case_id, [...(this.consents.get(input.case_id) ?? []), consent]);
      this.appendAudit(input.case_id, input.actor_id, "consent_revision_recorded", consent.receipt_sha256);
      return { consent, idempotent_replay: false };
    });
  }

  createPrivacyRequest(input: Readonly<{ actor_id: string; case_id: string; request_kind: PrivacyRequestKind; idempotency_key: string }>): Readonly<{ request: PrivacyRequestRevision; idempotent_replay: boolean }> {
    return this.idempotent(`${input.case_id}:privacy:${input.idempotency_key}`, input, () => {
      const caseRecord = this.cases.get(input.case_id)!;
      const revision = (this.privacyRequests.get(input.case_id)?.filter((request) => request.request_kind === input.request_kind).at(-1)?.revision ?? 0) + 1;
      const status = input.request_kind === "deletion" && caseRecord.retention.legal_hold ? "restricted_by_legal_hold" as const : "requested" as const;
      const commandSha = canonicalSha256(input);
      const unsigned = { request_id: `privacy:${canonicalSha256({ case_id: input.case_id, kind: input.request_kind })}`, case_id: input.case_id, request_kind: input.request_kind, revision, status, idempotency_key: input.idempotency_key, command_sha256: commandSha, created_at: this.clock.now() };
      const request = Object.freeze({ ...unsigned, receipt_sha256: canonicalSha256(unsigned) });
      this.privacyRequests.set(input.case_id, [...(this.privacyRequests.get(input.case_id) ?? []), request]);
      this.appendAudit(input.case_id, input.actor_id, "privacy_request_recorded", request.receipt_sha256);
      return { request, idempotent_replay: false };
    });
  }

  reserveUpload(input: Readonly<{ actor_id: string; case_id: string; document_id: string; expected_sha256: string; expected_length: number; detected_mime: string; expires_at: string; idempotency_key: string }>): Readonly<{ session: UploadSession; idempotent_replay: boolean }> {
    return this.idempotent(`${input.case_id}:upload:${input.idempotency_key}`, input, () => {
      if (!/^[0-9a-f]{64}$/.test(input.expected_sha256) || input.expected_length < 1 || input.expires_at <= this.clock.now()) throw new PortalError("UPLOAD_CONTRACT_INVALID");
      if (!new Set(["application/pdf", "image/jpeg", "image/png"]).has(input.detected_mime)) throw new PortalError("UPLOAD_CONTRACT_INVALID");
      const unsigned = { case_id: input.case_id, document_id: input.document_id, expected_sha256: input.expected_sha256, expected_length: input.expected_length, detected_mime: input.detected_mime, state: "reserved" as const, expires_at: input.expires_at };
      const sessionSha = canonicalSha256(unsigned);
      const session = Object.freeze({ ...unsigned, upload_session_id: `upload-session:${sessionSha}`, session_sha256: sessionSha });
      this.uploads.set(session.upload_session_id, session);
      this.appendAudit(input.case_id, input.actor_id, "upload_session_reserved", session.session_sha256);
      return { session, idempotent_replay: false };
    });
  }

  createInvite(input: Readonly<{ invite_id: string; case_id: string; owner_actor_id: string; audience: string; expires_at: string; synthetic_secret: string }>): Readonly<{ invite_id: string; token: string }> {
    if (this.invites.has(input.invite_id)) throw new PortalError("SYNTHETIC_INVITE_COLLISION");
    const token = `tivdoc-synthetic-invite:${canonicalSha256(input)}`;
    this.invites.set(input.invite_id, Object.freeze({ invite_id: input.invite_id, case_id: input.case_id, owner_actor_id: input.owner_actor_id, audience: input.audience, expires_at: input.expires_at, token_sha256: canonicalSha256(token), accepted_at: null }));
    return { invite_id: input.invite_id, token };
  }

  acceptInvite(input: Readonly<{ token: string; audience: string }>): Readonly<{ case_id: string; owner_actor_id: string; accepted_at: string }> {
    const tokenSha = canonicalSha256(input.token);
    const invite = [...this.invites.values()].find((candidate) => candidate.token_sha256 === tokenSha);
    if (!invite || invite.audience !== input.audience || invite.expires_at <= this.clock.now() || invite.accepted_at !== null) throw new PortalError("PORTAL_NOT_FOUND");
    const acceptedAt = this.clock.now();
    this.invites.set(invite.invite_id, Object.freeze({ ...invite, accepted_at: acceptedAt }));
    this.appendAudit(invite.case_id, invite.owner_actor_id, "synthetic_invite_accepted", tokenSha);
    return { case_id: invite.case_id, owner_actor_id: invite.owner_actor_id, accepted_at: acceptedAt };
  }

  createReportGrant(input: Readonly<{ actor_id: string; case_id: string; report: StoredReportEdition; expires_at: string }>): ReportAccessGrant {
    if (input.expires_at <= this.clock.now()) throw new PortalError("REPORT_GRANT_EXPIRY_INVALID");
    const unsigned = { case_id: input.case_id, report_id: input.report.report_id, artifact_sha256: input.report.artifact_sha256, object_version_id: input.report.object_version_id, expires_at: input.expires_at };
    const grant = Object.freeze({ ...unsigned, grant_id: `report-grant:${canonicalSha256(unsigned)}`, grant_sha256: canonicalSha256(unsigned) });
    this.reportGrants.set(grant.grant_id, grant);
    this.appendAudit(input.case_id, input.actor_id, "report_access_granted", grant.grant_sha256);
    return clone(grant);
  }

  readArtifact(objectVersionId: string): Uint8Array | null { return clone(this.artifacts.get(objectVersionId) ?? null); }
  reportGrant(grantId: string): ReportAccessGrant | null { return clone(this.reportGrants.get(grantId) ?? null); }

  private invalidateReleasedReports(caseId: string, mutationSha256: string): void {
    const history = [...(this.reports.get(caseId) ?? [])];
    const latestById = new Map<string, StoredReportEdition>();
    for (const report of history) latestById.set(report.report_id, report);
    for (const report of latestById.values()) {
      if (report.release_state !== "released") continue;
      history.push(Object.freeze({ ...report, report_revision: report.report_revision + 1, release_state: "invalidated", release_receipt_sha256: null, created_at: this.clock.now(), blocker_codes: [...report.blocker_codes, `upstream_declared_candidate_changed:${mutationSha256}`] }));
    }
    this.reports.set(caseId, history);
  }

  private appendAudit(caseId: string, actorId: string, action: string, resourceSha256: string): PortalAuditReceipt {
    const previous = this.audit.at(-1)?.receipt_sha256 ?? null;
    const unsigned = { sequence: this.audit.length + 1, case_id: caseId, actor_id: actorId, action, resource_sha256: resourceSha256, previous_sha256: previous, occurred_at: this.clock.now() };
    const receipt = Object.freeze({ ...unsigned, receipt_sha256: canonicalSha256(unsigned) });
    this.audit.push(receipt);
    return receipt;
  }

  private idempotent<T extends Readonly<{ idempotent_replay: boolean }>>(key: string, command: unknown, mutate: () => T): T {
    const commandSha = canonicalSha256(command);
    const prior = this.idempotency.get(key) as IdempotencyRecord<T> | undefined;
    if (prior) {
      if (prior.command_sha256 !== commandSha) throw new PortalError("IDEMPOTENCY_KEY_COMMAND_MISMATCH");
      return clone({ ...prior.result, idempotent_replay: true });
    }
    const result = mutate();
    this.idempotency.set(key, { command_sha256: commandSha, result });
    return clone(result);
  }
}

function clone<T>(value: T): T { return structuredClone(value); }
