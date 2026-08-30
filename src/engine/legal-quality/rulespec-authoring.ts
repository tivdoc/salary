import { z } from "zod";
import { knownFactPaths, factPathSchema, type FactPath } from "../facts/fact-paths.ts";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { WAVE3_TOPICS, type Wave3Topic } from "../wave3/contracts.ts";

export const RULESPEC_AUTHORING_SCHEMA = "tivdoc-rulespec-authoring-skeleton-v0.7.0" as const;
export const RULESPEC_ACTIVATION_LINTER_VERSION = "tivdoc-rulespec-activation-linter-v0.7.0" as const;

const idSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/);
const placeholderSchema = z.string().regex(/^\{\{[A-Z][A-Z0-9_]{2,79}\}\}$/);

const authoringOperationSchema = z.object({
  operation_id: idSchema,
  operation_kind: placeholderSchema,
  input_refs: z.array(z.string().min(3).max(160)).max(16).readonly(),
  output_kind: placeholderSchema,
  unit: placeholderSchema,
  rounding: placeholderSchema,
  legal_value: z.null(),
  formula: z.null(),
}).strict().readonly();

export const ruleSpecAuthoringSkeletonSchema = z.object({
  schema_version: z.literal(RULESPEC_AUTHORING_SCHEMA),
  skeleton_id: idSchema,
  skeleton_version: z.literal("0.7.0"),
  topic: z.enum(WAVE3_TOPICS),
  state: z.literal("non_operative_human_authoring_template"),
  catalog_boundary: z.literal("real_inactive"),
  available_fact_paths: z.array(factPathSchema).min(1).readonly(),
  applicability_guards: z.array(z.object({ guard_id: idSchema, fact_path: factPathSchema, comparator: placeholderSchema, expected: placeholderSchema }).strict()).min(1).readonly(),
  parameter_references: z.array(z.object({ parameter_ref: placeholderSchema, required_version: placeholderSchema, required_approval_sha256: placeholderSchema }).strict()).min(1).readonly(),
  operations: z.array(authoringOperationSchema).min(1).max(64).readonly(),
  output_ref: placeholderSchema,
  citations: z.array(z.object({ citation_id: placeholderSchema, source_version_id: placeholderSchema, pinpoint: placeholderSchema, verified: z.literal(false) }).strict()).min(1).readonly(),
  approvals: z.object({ author_sha256: z.null(), legal_reviewer_sha256: z.null(), rulespec_approval_sha256: z.null(), golden_case_set_sha256: z.null() }).strict(),
  missing_fact_behavior: z.literal("BLOCKED_MISSING_FACT"),
  conflicted_fact_behavior: z.literal("BLOCKED_CONFLICTED_FACT"),
  dependencies: z.array(z.object({ dependency_id: placeholderSchema, dependency_version: placeholderSchema, approval_sha256: z.null() }).strict()).min(1).readonly(),
  resource_policy: z.object({ max_operations: z.literal(64), max_depth: z.literal(16), max_input_refs: z.literal(16), max_integer_digits: z.literal(128) }).strict(),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().readonly();

export type RuleSpecAuthoringSkeleton = z.infer<typeof ruleSpecAuthoringSkeletonSchema>;

export type RuleSpecActivationBlocker =
  | "RULESPEC_SCHEMA_INVALID"
  | "RULESPEC_CONTENT_HASH_MISMATCH"
  | "RULESPEC_UNRESOLVED_PLACEHOLDER"
  | "RULESPEC_DIRECT_LEGAL_LITERAL_FORBIDDEN"
  | "RULESPEC_CITATION_UNVERIFIED"
  | "RULESPEC_APPROVAL_MISSING"
  | "RULESPEC_ARBITRARY_CODE_FORBIDDEN"
  | "RULESPEC_DYNAMIC_IMPORT_FORBIDDEN"
  | "RULESPEC_CYCLE_DETECTED"
  | "RULESPEC_DEPTH_LIMIT_EXCEEDED"
  | "RULESPEC_OPERATION_LIMIT_EXCEEDED"
  | "RULESPEC_UNSAFE_UNIT"
  | "RULESPEC_FACT_PATH_UNDECLARED"
  | "RULESPEC_DEPENDENCY_UNAPPROVED"
  | "RULESPEC_MONEY_OR_RATIONAL_BOUNDS_UNPROVEN";

export type RuleSpecActivationReport = Readonly<{
  schema_version: typeof RULESPEC_ACTIVATION_LINTER_VERSION;
  skeleton_id: string | null;
  topic: string | null;
  activation_allowed: false;
  execution_allowed: false;
  blockers: readonly RuleSpecActivationBlocker[];
  candidate_sha256: string;
  report_sha256: string;
}>;

const FACTS_BY_TOPIC: Readonly<Record<Wave3Topic, readonly FactPath[]>> = Object.freeze({
  minimum_wage: ["compensation.salary_type", "compensation.base_monthly_salary", "compensation.hourly_rate", "documents.period"],
  working_time: ["work.regular_hours", "work.overtime_hours", "work.overtime_125_hours", "work.overtime_150_hours", "documents.period"],
  pension: ["pension.base_salary", "pension.contributions", "pension.severance_contribution", "documents.period"],
  travel: ["travel.reimbursement", "work.workdays", "documents.period"],
  convalescence: ["convalescence.payment", "employment.start_date", "employment.end_date", "documents.period"],
  vacation: ["leave.vacation_balance", "work.workdays", "documents.period"],
  sick_leave: ["leave.sick_balance", "work.workdays", "documents.period"],
});

function unsignedSkeleton(topic: Wave3Topic) {
  const facts = FACTS_BY_TOPIC[topic];
  return {
    schema_version: RULESPEC_AUTHORING_SCHEMA,
    skeleton_id: `rulespec.authoring.${topic}`,
    skeleton_version: "0.7.0" as const,
    topic,
    state: "non_operative_human_authoring_template" as const,
    catalog_boundary: "real_inactive" as const,
    available_fact_paths: facts,
    applicability_guards: [{ guard_id: `guard.${topic}.applicability`, fact_path: facts[0], comparator: "{{COMPARATOR}}", expected: "{{EXPECTED_VALUE}}" }],
    parameter_references: [{ parameter_ref: "{{PARAMETER_ID}}", required_version: "{{PARAMETER_VERSION}}", required_approval_sha256: "{{PARAMETER_APPROVAL_SHA256}}" }],
    operations: [{ operation_id: `operation.${topic}.placeholder`, operation_kind: "{{OPERATION_KIND}}", input_refs: [facts[0], "{{PARAMETER_ID}}"], output_kind: "{{OUTPUT_KIND}}", unit: "{{UNIT}}", rounding: "{{ROUNDING_POLICY}}", legal_value: null, formula: null }],
    output_ref: "{{OUTPUT_REF}}",
    citations: [{ citation_id: "{{CITATION_ID}}", source_version_id: "{{SOURCE_VERSION_ID}}", pinpoint: "{{PINPOINT}}", verified: false as const }],
    approvals: { author_sha256: null, legal_reviewer_sha256: null, rulespec_approval_sha256: null, golden_case_set_sha256: null },
    missing_fact_behavior: "BLOCKED_MISSING_FACT" as const,
    conflicted_fact_behavior: "BLOCKED_CONFLICTED_FACT" as const,
    dependencies: [{ dependency_id: "{{DEPENDENCY_ID}}", dependency_version: "{{DEPENDENCY_VERSION}}", approval_sha256: null }],
    resource_policy: { max_operations: 64 as const, max_depth: 16 as const, max_input_refs: 16 as const, max_integer_digits: 128 as const },
  };
}

export function buildRuleSpecAuthoringSkeleton(topic: Wave3Topic): RuleSpecAuthoringSkeleton {
  const content = unsignedSkeleton(topic);
  return deepFreeze(ruleSpecAuthoringSkeletonSchema.parse({ ...content, content_sha256: canonicalSha256(content) })) as RuleSpecAuthoringSkeleton;
}

export function buildSevenRuleSpecAuthoringSkeletons(): readonly RuleSpecAuthoringSkeleton[] {
  return deepFreeze(WAVE3_TOPICS.map(buildRuleSpecAuthoringSkeleton)) as readonly RuleSpecAuthoringSkeleton[];
}

export function lintRuleSpecForActivation(candidate: unknown): RuleSpecActivationReport {
  const blockers = new Set<RuleSpecActivationBlocker>();
  const candidateSha = canonicalSha256(candidate);
  const raw = JSON.stringify(candidate);
  if (/(?:javascript|eval\s*\(|function\s*\(|=>|callback|new\s+Function)/i.test(raw)) blockers.add("RULESPEC_ARBITRARY_CODE_FORBIDDEN");
  if (/(?:dynamic[_ -]?import|import\s*\()/i.test(raw)) blockers.add("RULESPEC_DYNAMIC_IMPORT_FORBIDDEN");
  const parsed = ruleSpecAuthoringSkeletonSchema.safeParse(candidate);
  if (!parsed.success) blockers.add("RULESPEC_SCHEMA_INVALID");
  const value = parsed.success ? parsed.data : candidate as Partial<RuleSpecAuthoringSkeleton>;
  if (parsed.success) {
    const { content_sha256: expected, ...content } = parsed.data;
    if (canonicalSha256(content) !== expected) blockers.add("RULESPEC_CONTENT_HASH_MISMATCH");
  }
  if (hasPlaceholder(value)) blockers.add("RULESPEC_UNRESOLVED_PLACEHOLDER");
  if (hasDirectLiteral((value as { operations?: unknown }).operations)) blockers.add("RULESPEC_DIRECT_LEGAL_LITERAL_FORBIDDEN");
  const citations = Array.isArray(value.citations) ? value.citations : [];
  if (citations.length === 0 || citations.some((citation) => !citation.verified)) blockers.add("RULESPEC_CITATION_UNVERIFIED");
  const approvals = value.approvals;
  if (!approvals || Object.values(approvals).some((entry) => entry === null)) blockers.add("RULESPEC_APPROVAL_MISSING");
  const dependencies = Array.isArray(value.dependencies) ? value.dependencies : [];
  if (dependencies.length === 0 || dependencies.some((entry) => entry.approval_sha256 === null)) blockers.add("RULESPEC_DEPENDENCY_UNAPPROVED");
  const factPaths = Array.isArray(value.available_fact_paths) ? value.available_fact_paths : [];
  if (factPaths.some((path) => !knownFactPaths.includes(path as FactPath))) blockers.add("RULESPEC_FACT_PATH_UNDECLARED");
  const operations = Array.isArray(value.operations) ? value.operations : [];
  if (operations.length > 64) blockers.add("RULESPEC_OPERATION_LIMIT_EXCEEDED");
  if (operations.some((operation) => !isSafeUnit(operation.unit))) blockers.add("RULESPEC_UNSAFE_UNIT");
  const graph = operationGraph(operations);
  if (graph.cycle) blockers.add("RULESPEC_CYCLE_DETECTED");
  if (graph.depth > 16) blockers.add("RULESPEC_DEPTH_LIMIT_EXCEEDED");
  blockers.add("RULESPEC_MONEY_OR_RATIONAL_BOUNDS_UNPROVEN");
  const payload = {
    schema_version: RULESPEC_ACTIVATION_LINTER_VERSION,
    skeleton_id: typeof value.skeleton_id === "string" ? value.skeleton_id : null,
    topic: typeof value.topic === "string" ? value.topic : null,
    activation_allowed: false as const,
    execution_allowed: false as const,
    blockers: [...blockers].sort(),
    candidate_sha256: candidateSha,
  };
  return deepFreeze({ ...payload, report_sha256: canonicalSha256(payload) }) as RuleSpecActivationReport;
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return /\{\{[^}]+\}\}/.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).some(hasPlaceholder));
}

function hasDirectLiteral(operations: unknown): boolean {
  if (!Array.isArray(operations)) return false;
  return operations.some((operation) => {
    if (!operation || typeof operation !== "object") return false;
    const record = operation as Record<string, unknown>;
    return Object.entries(record).some(([key, entry]) => (typeof entry === "number" || (typeof entry === "string" && /^(?:-?\d+(?:\.\d+)?|\d+\/\d+)$/.test(entry))) && !["operation_id"].includes(key));
  });
}

function isSafeUnit(unit: unknown): boolean {
  return typeof unit === "string" && (/^\{\{[A-Z0-9_]+\}\}$/.test(unit) || ["ratio", "hours", "days", "months", "currency.synthetic"].includes(unit));
}

function operationGraph(operations: readonly unknown[]): Readonly<{ cycle: boolean; depth: number }> {
  const nodes = new Map<string, readonly string[]>();
  for (const operation of operations) {
    if (!operation || typeof operation !== "object") continue;
    const record = operation as Record<string, unknown>;
    if (typeof record.operation_id !== "string") continue;
    const refs = Array.isArray(record.input_refs) ? record.input_refs.filter((ref): ref is string => typeof ref === "string") : [];
    nodes.set(record.operation_id, refs);
  }
  let cycle = false;
  let maximum = 0;
  const visiting = new Set<string>();
  const memo = new Map<string, number>();
  const visit = (node: string): number => {
    if (memo.has(node)) return memo.get(node)!;
    if (visiting.has(node)) { cycle = true; return 0; }
    visiting.add(node);
    const depth = 1 + Math.max(0, ...(nodes.get(node) ?? []).filter((ref) => nodes.has(ref)).map(visit));
    visiting.delete(node);
    memo.set(node, depth);
    maximum = Math.max(maximum, depth);
    return depth;
  };
  for (const node of nodes.keys()) visit(node);
  return { cycle, depth: maximum };
}
