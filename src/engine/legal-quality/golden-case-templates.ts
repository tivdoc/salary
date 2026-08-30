import { z } from "zod";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";

export const GOLDEN_TEMPLATE_SCHEMA = "tivdoc-blank-legal-golden-case-v0.7.0" as const;
export const GOLDEN_LEDGER_SCHEMA = "tivdoc-legal-golden-import-ledger-v0.7.0" as const;

export const GOLDEN_SCENARIOS = [
  "current",
  "effective_date_boundary",
  "sector_population",
  "missing_conflicted_facts",
  "precedence_overlap",
  "parameter_rounding_boundary",
] as const;

const id = z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const blankBinding = z.object({ id: z.null(), version: z.null(), sha256: z.null() }).strict();

export const blankGoldenCaseTemplateSchema = z.object({
  schema_version: z.literal(GOLDEN_TEMPLATE_SCHEMA),
  template_id: id,
  template_version: z.literal("0.7.0"),
  topic: z.enum(WAVE3_TOPICS),
  scenario: z.enum(GOLDEN_SCENARIOS),
  state: z.literal("blank_human_legal_review_template"),
  legal_ground_truth: z.literal(false),
  synthetic_mechanics_only: z.literal(false),
  input_snapshot: blankBinding,
  source_set: z.object({ source_version_ids: z.array(id).max(0), source_set_sha256: z.null() }).strict(),
  rulespec: blankBinding,
  parameters: z.object({ parameter_version_ids: z.array(id).max(0), parameter_set_sha256: z.null() }).strict(),
  period_scope: z.object({ target_from: z.null(), target_to: z.null(), as_of: z.null(), sector: z.null(), population: z.null() }).strict(),
  expected: z.object({ applicability: z.null(), trace_sha256: z.null(), result: z.null(), citation_ids: z.array(id).max(0), blocker_codes: z.array(id).max(0) }).strict(),
  reviewers: z.object({ author_id: z.null(), legal_reviewer_id: z.null(), independent_reviewer_id: z.null(), signatures: z.array(sha).max(0) }).strict(),
  approval_state: z.literal("blank_not_approvable"),
  dependencies_sha256: z.null(),
  content_sha256: sha,
}).strict().readonly();

export type BlankGoldenCaseTemplate = z.infer<typeof blankGoldenCaseTemplateSchema>;

function unsignedTemplate(topic: Wave3Topic, scenario: typeof GOLDEN_SCENARIOS[number]) {
  return {
    schema_version: GOLDEN_TEMPLATE_SCHEMA,
    template_id: `golden.blank.${topic}.${scenario}`,
    template_version: "0.7.0" as const,
    topic,
    scenario,
    state: "blank_human_legal_review_template" as const,
    legal_ground_truth: false as const,
    synthetic_mechanics_only: false as const,
    input_snapshot: { id: null, version: null, sha256: null },
    source_set: { source_version_ids: [] as never[], source_set_sha256: null },
    rulespec: { id: null, version: null, sha256: null },
    parameters: { parameter_version_ids: [] as never[], parameter_set_sha256: null },
    period_scope: { target_from: null, target_to: null, as_of: null, sector: null, population: null },
    expected: { applicability: null, trace_sha256: null, result: null, citation_ids: [] as never[], blocker_codes: [] as never[] },
    reviewers: { author_id: null, legal_reviewer_id: null, independent_reviewer_id: null, signatures: [] as never[] },
    approval_state: "blank_not_approvable" as const,
    dependencies_sha256: null,
  };
}

export function buildBlankGoldenCaseTemplates(): readonly BlankGoldenCaseTemplate[] {
  const templates = WAVE3_TOPICS.flatMap((topic) => GOLDEN_SCENARIOS.map((scenario) => {
    const content = unsignedTemplate(topic, scenario);
    return blankGoldenCaseTemplateSchema.parse({ ...content, content_sha256: canonicalSha256(content) });
  }));
  return deepFreeze(templates) as readonly BlankGoldenCaseTemplate[];
}

export function validateBlankGoldenCaseTemplate(candidate: unknown): BlankGoldenCaseTemplate {
  const parsed = blankGoldenCaseTemplateSchema.parse(candidate);
  const { content_sha256: expected, ...content } = parsed;
  if (canonicalSha256(content) !== expected) throw new Error("GOLDEN_TEMPLATE_CONTENT_HASH_MISMATCH");
  return deepFreeze(parsed) as BlankGoldenCaseTemplate;
}

export function assertGoldenTemplateCannotApprove(candidate: unknown): never {
  validateBlankGoldenCaseTemplate(candidate);
  throw new Error("BLANK_GOLDEN_TEMPLATE_CANNOT_BE_APPROVED");
}

export type GoldenImportEvent = Readonly<{
  schema_version: typeof GOLDEN_LEDGER_SCHEMA;
  sequence: number;
  event_id: string;
  event_kind: "blank_template_imported" | "dependency_invalidated";
  template_id: string;
  template_version: string;
  template_sha256: string;
  dependency_sha256: string | null;
  reason_code: string;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

export type GoldenImportReceipt = Readonly<{
  template_id: string;
  revision: number;
  state: "imported_blank_not_approvable" | "invalidated";
  template_sha256: string;
  event_sha256: string;
  idempotent_replay: boolean;
}>;

export class BlankGoldenImportLedger {
  readonly #events: GoldenImportEvent[] = [];
  readonly #templates = new Map<string, Readonly<{ template: BlankGoldenCaseTemplate; revision: number; state: GoldenImportReceipt["state"] }>>();
  readonly #idempotency = new Map<string, Readonly<{ command_sha256: string; receipt: GoldenImportReceipt }>>();

  importBlank(input: Readonly<{ template: unknown; idempotency_key: string; reason_code: string }>): GoldenImportReceipt {
    const template = validateBlankGoldenCaseTemplate(input.template);
    const commandSha = canonicalSha256({ action: "import_blank", template_sha256: template.content_sha256, reason_code: input.reason_code });
    const replay = this.#replay(input.idempotency_key, commandSha);
    if (replay) return replay;
    const existing = this.#templates.get(template.template_id);
    if (existing && existing.template.content_sha256 !== template.content_sha256) throw new Error("GOLDEN_TEMPLATE_APPEND_ONLY_VERSION_REQUIRED");
    const revision = existing?.revision ?? 1;
    const event = this.#append("blank_template_imported", template, null, input.reason_code);
    this.#templates.set(template.template_id, deepFreeze({ template, revision, state: "imported_blank_not_approvable" }));
    const receipt = deepFreeze({ template_id: template.template_id, revision, state: "imported_blank_not_approvable" as const, template_sha256: template.content_sha256, event_sha256: event.event_sha256, idempotent_replay: false });
    this.#idempotency.set(input.idempotency_key, { command_sha256: commandSha, receipt });
    return receipt;
  }

  invalidateDependency(input: Readonly<{ template_id: string; expected_template_sha256: string; dependency_sha256: string; idempotency_key: string; reason_code: string }>): GoldenImportReceipt {
    const stored = this.#templates.get(input.template_id);
    if (!stored) throw new Error("GOLDEN_TEMPLATE_NOT_IMPORTED");
    if (stored.template.content_sha256 !== input.expected_template_sha256) throw new Error("GOLDEN_TEMPLATE_STALE_HASH");
    const commandSha = canonicalSha256({ action: "invalidate_dependency", ...input });
    const replay = this.#replay(input.idempotency_key, commandSha);
    if (replay) return replay;
    const event = this.#append("dependency_invalidated", stored.template, input.dependency_sha256, input.reason_code);
    const revision = stored.revision + 1;
    this.#templates.set(input.template_id, deepFreeze({ ...stored, revision, state: "invalidated" }));
    const receipt = deepFreeze({ template_id: input.template_id, revision, state: "invalidated" as const, template_sha256: stored.template.content_sha256, event_sha256: event.event_sha256, idempotent_replay: false });
    this.#idempotency.set(input.idempotency_key, { command_sha256: commandSha, receipt });
    return receipt;
  }

  events(): readonly GoldenImportEvent[] {
    return deepFreeze(this.#events.map((event) => ({ ...event }))) as readonly GoldenImportEvent[];
  }

  #replay(key: string, commandSha: string): GoldenImportReceipt | null {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,159}$/.test(key)) throw new Error("GOLDEN_IDEMPOTENCY_KEY_INVALID");
    const replay = this.#idempotency.get(key);
    if (!replay) return null;
    if (replay.command_sha256 !== commandSha) throw new Error("GOLDEN_IDEMPOTENCY_CONFLICT");
    return deepFreeze({ ...replay.receipt, idempotent_replay: true });
  }

  #append(kind: GoldenImportEvent["event_kind"], template: BlankGoldenCaseTemplate, dependencySha: string | null, reasonCode: string): GoldenImportEvent {
    if (!/^[A-Z][A-Z0-9_]{2,99}$/.test(reasonCode)) throw new Error("GOLDEN_REASON_CODE_INVALID");
    if (dependencySha !== null && !/^[a-f0-9]{64}$/.test(dependencySha)) throw new Error("GOLDEN_DEPENDENCY_HASH_INVALID");
    const prior = this.#events.at(-1)?.event_sha256 ?? null;
    const payload = { schema_version: GOLDEN_LEDGER_SCHEMA, sequence: this.#events.length + 1, event_id: `golden.event.${String(this.#events.length + 1).padStart(6, "0")}`, event_kind: kind, template_id: template.template_id, template_version: template.template_version, template_sha256: template.content_sha256, dependency_sha256: dependencySha, reason_code: reasonCode, prior_event_sha256: prior };
    const event = deepFreeze({ ...payload, event_sha256: canonicalSha256(payload) }) as GoldenImportEvent;
    this.#events.push(event);
    return event;
  }
}

export function diffGoldenTemplateVersions(left: readonly BlankGoldenCaseTemplate[], right: readonly BlankGoldenCaseTemplate[]) {
  const leftMap = new Map(left.map((item) => [item.template_id, validateBlankGoldenCaseTemplate(item)]));
  const rightMap = new Map(right.map((item) => [item.template_id, validateBlankGoldenCaseTemplate(item)]));
  const ids = [...new Set([...leftMap.keys(), ...rightMap.keys()])].sort();
  const rows = ids.map((template_id) => {
    const before = leftMap.get(template_id);
    const after = rightMap.get(template_id);
    return deepFreeze({ template_id, status: !before ? "added" as const : !after ? "removed" as const : before.content_sha256 === after.content_sha256 ? "unchanged" as const : "changed" as const, before_sha256: before?.content_sha256 ?? null, after_sha256: after?.content_sha256 ?? null });
  });
  const payload = { schema_version: "tivdoc-golden-template-version-diff-v0.7.0", rows };
  return deepFreeze({ ...payload, diff_sha256: canonicalSha256(payload) });
}
