import { z } from "zod";
import type { ImmutableDocument } from "../domain/documents.ts";
import { immutableDocumentSchema } from "../domain/documents.ts";
import {
  dateRangeSchema,
  domainCodeSchema,
  isoTimestampSchema,
  uuidSchema,
  type DateRange,
} from "../domain/primitives.ts";
import type { CanonicalFact } from "../facts/contracts.ts";
import type { FactPath } from "../facts/fact-paths.ts";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import { employmentSnapshotSchema } from "../facts/snapshot.ts";
import type {
  RegisteredRuleInputMappingRegistry,
  RuleInputMapping,
} from "../rule-input/mapping-registry.ts";
import { registeredRuleInputMappingRegistrySchema } from "../rule-input/mapping-registry.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import { canonicalSha256, canonicalStringify, deepFreeze } from "../rule-runtime/canonical.ts";
import { ruleInputSnapshotSchema, type RuleInputSnapshot } from "../wave1/contracts.ts";
import type { ExtractionResult, RawAdditionalComponent, RawCandidateField } from "./contracts.ts";
import { extractionResultSchema } from "./contracts.ts";

export const supportedIntakeDocumentTypeSchema = z.enum([
  "payslip",
  "employment_agreement",
  "attendance",
  "pension_deposit",
  "travel",
  "leave_absence",
  "termination",
]);

export type SupportedIntakeDocumentType = z.infer<typeof supportedIntakeDocumentTypeSchema>;

export const ruleInputScopeRequirementSchema = z
  .object({
    scope_id: domainCodeSchema,
    topic: domainCodeSchema,
    period: dateRangeSchema,
    input_ids: z.array(domainCodeSchema).min(1),
  })
  .strict()
  .superRefine((scope, context) => {
    if (new Set(scope.input_ids).size !== scope.input_ids.length) {
      context.addIssue({ code: "custom", message: "rule_input_scope_ids_must_be_unique", path: ["input_ids"] });
    }
  })
  .readonly();

export type RuleInputScopeRequirement = Readonly<{
  scope_id: string;
  topic: string;
  period: DateRange;
  input_ids: readonly string[];
}>;

export type MultiDocumentTechnicalIssueCode =
  | "document.corrected"
  | "document.duplicate_content"
  | "document.extraction_missing"
  | "document.provenance_missing"
  | "document.supersedes_cycle"
  | "document.supersedes_missing"
  | "document.type_unsupported"
  | "employer.mismatch"
  | "extraction.failed"
  | "extraction.partial"
  | "fact.conflicted"
  | "fact.document_reference_missing"
  | "identity.conflict"
  | "period.cross_document_gap"
  | "period.missing_month"
  | "period.overlap"
  | "termination.period_mismatch";

export type MultiDocumentTechnicalIssue = Readonly<{
  code: MultiDocumentTechnicalIssueCode;
  severity: "warning" | "blocker";
  document_ids: readonly string[];
  fact_paths: readonly FactPath[];
  period_keys: readonly string[];
  evidence_sha256: string;
}>;

export type MultiDocumentManifestEntry = Readonly<{
  document: ImmutableDocument;
  supported_type: SupportedIntakeDocumentType | "unsupported";
  lineage_status: "current" | "superseded" | "correction";
  extraction: Readonly<{
    extraction_id: string;
    status: ExtractionResult["status"];
    detected_document_type: ExtractionResult["detected_document_type"];
    provider_id: string;
    extractor_version: string;
    model_version: string | null;
    extraction_sha256: string;
    raw_fields: readonly RawCandidateField[];
    raw_additional_components: readonly RawAdditionalComponent[];
    identity_signal_hashes: readonly string[];
  }> | null;
  normalized_facts: readonly CanonicalFact[];
  entry_sha256: string;
}>;

export type EmploymentTimelineMonth = Readonly<{
  period_key: string;
  active_document_ids: readonly string[];
  active_document_types: readonly string[];
  documented_fact_ids: readonly string[];
  issue_codes: readonly MultiDocumentTechnicalIssueCode[];
  month_sha256: string;
}>;

export type ClarificationFactState = Readonly<{
  fact_path: FactPath;
  status: "missing" | "conflicted";
  fact_ids: readonly string[];
  state_sha256: string;
}>;

export type DeclaredRuleInputRequirement = Readonly<{
  requirement_id: string;
  requirement_version: string;
  fact_path: FactPath;
  requirement_sha256: string;
}>;

export type RuleInputCoverageState =
  | "covered"
  | "missing"
  | "conflicted"
  | "unreadable"
  | "stale"
  | "unconfirmed"
  | "rejected"
  | "below_confidence";

export type ScopedRuleInputView = Readonly<{
  scope: RuleInputScopeRequirement;
  snapshot: RuleInputSnapshot;
  coverage: readonly Readonly<{
    input_id: string;
    fact_path: FactPath;
    state: RuleInputCoverageState;
    fact_id: string | null;
    provenance_sha256: string | null;
  }>[];
  blocker_codes: readonly string[];
  coverage_sha256: string;
}>;

export type MultiDocumentIntakeResult = Readonly<{
  schema_version: "tivdoc-multi-document-intake-v0.10.0";
  case_id: string;
  manifest: readonly MultiDocumentManifestEntry[];
  manifest_sha256: string;
  timeline: readonly EmploymentTimelineMonth[];
  timeline_sha256: string;
  technical_issues: readonly MultiDocumentTechnicalIssue[];
  clarification_fact_states: readonly ClarificationFactState[];
  declared_rule_input_requirements: readonly DeclaredRuleInputRequirement[];
  rule_input_views: readonly ScopedRuleInputView[];
  retained_warning_codes: readonly string[];
  result_sha256: string;
}>;

export type MultiDocumentIntakeInput = Readonly<{
  case_id: string;
  documents: readonly ImmutableDocument[];
  extractions: readonly ExtractionResult[];
  fact_snapshot: EmploymentSnapshot;
  mapping_registry: RegisteredRuleInputMappingRegistry;
  scopes: readonly RuleInputScopeRequirement[];
  prepared_at: string;
  required_period?: DateRange;
  prior_warning_codes?: readonly string[];
}>;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}

function monthsInRange(range: DateRange): readonly string[] {
  const first = range.start_date.slice(0, 7);
  const last = (range.end_date ?? range.start_date).slice(0, 7);
  const months: string[] = [];
  for (let cursor = first; cursor <= last; cursor = nextMonth(cursor)) months.push(cursor);
  return months;
}

function rangesOverlap(left: DateRange, right: DateRange): boolean {
  const leftEnd = left.end_date ?? left.start_date;
  const rightEnd = right.end_date ?? right.start_date;
  return left.start_date <= rightEnd && right.start_date <= leftEnd;
}

function issue(
  code: MultiDocumentTechnicalIssueCode,
  severity: MultiDocumentTechnicalIssue["severity"],
  documentIds: readonly string[] = [],
  factPaths: readonly FactPath[] = [],
  periodKeys: readonly string[] = [],
): MultiDocumentTechnicalIssue {
  const seed = {
    code,
    severity,
    document_ids: uniqueSorted(documentIds),
    fact_paths: uniqueSorted(factPaths) as readonly FactPath[],
    period_keys: uniqueSorted(periodKeys),
  };
  return deepFreeze({ ...seed, evidence_sha256: canonicalSha256(seed) });
}

function factDocumentIds(fact: CanonicalFact): readonly string[] {
  return uniqueSorted(
    fact.provenance.flatMap((entry) =>
      entry.source_type === "documented" ? [entry.source_reference.document_id] : [],
    ),
  );
}

function validateInput(input: MultiDocumentIntakeInput): Readonly<{
  documents: readonly ImmutableDocument[];
  extractions: readonly ExtractionResult[];
  factSnapshot: EmploymentSnapshot;
  registry: RegisteredRuleInputMappingRegistry;
  scopes: readonly RuleInputScopeRequirement[];
  preparedAt: string;
  requiredPeriod: DateRange | null;
}> {
  const caseId = uuidSchema.parse(input.case_id);
  const documents = input.documents.map((entry) => immutableDocumentSchema.parse(entry));
  const extractions = input.extractions.map((entry) => extractionResultSchema.parse(entry));
  const factSnapshot = createCanonicalRuleInputSnapshot(
    employmentSnapshotSchema.parse(input.fact_snapshot),
  ).canonical_snapshot;
  const registry = registeredRuleInputMappingRegistrySchema.parse(input.mapping_registry);
  const scopes = input.scopes.map((entry) => {
    const parsed = ruleInputScopeRequirementSchema.parse(entry);
    return ruleInputScopeRequirementSchema.parse({ ...parsed, input_ids: [...parsed.input_ids].sort(compareStrings) });
  });
  const preparedAt = isoTimestampSchema.parse(input.prepared_at);
  const requiredPeriod = input.required_period === undefined
    ? null
    : dateRangeSchema.parse(input.required_period);

  if (documents.some((entry) => entry.case_id !== caseId) || factSnapshot.case_id !== caseId) {
    throw new Error("multi_document_case_boundary_violation");
  }
  if (new Set(documents.map((entry) => entry.document_id)).size !== documents.length) {
    throw new Error("multi_document_id_duplicate");
  }
  if (new Set(extractions.map((entry) => entry.extraction_id)).size !== extractions.length) {
    throw new Error("multi_document_extraction_id_duplicate");
  }
  if (new Set(extractions.map((entry) => entry.document_id)).size !== extractions.length) {
    throw new Error("multi_document_multiple_extractions_require_explicit_resolution");
  }
  if (new Set(scopes.map((entry) => entry.scope_id)).size !== scopes.length) {
    throw new Error("multi_document_scope_id_duplicate");
  }
  return { documents, extractions, factSnapshot, registry, scopes, preparedAt, requiredPeriod };
}

function supportedType(document: ImmutableDocument): SupportedIntakeDocumentType | "unsupported" {
  const parsed = supportedIntakeDocumentTypeSchema.safeParse(document.document_type);
  return parsed.success ? parsed.data : "unsupported";
}

function lineageStatuses(documents: readonly ImmutableDocument[]): ReadonlyMap<string, MultiDocumentManifestEntry["lineage_status"]> {
  const superseded = new Set(
    documents.flatMap((document) =>
      document.supersedes_document_id === null ? [] : [document.supersedes_document_id],
    ),
  );
  return new Map(
    documents.map((document) => [
      document.document_id,
      superseded.has(document.document_id)
        ? "superseded"
        : document.supersedes_document_id === null
          ? "current"
          : "correction",
    ] as const),
  );
}

function normalizedFactsForDocument(
  documentId: string,
  facts: readonly CanonicalFact[],
): readonly CanonicalFact[] {
  return facts
    .filter((fact) => factDocumentIds(fact).includes(documentId))
    .sort((left, right) => compareStrings(`${left.path}\u0000${left.fact_id}`, `${right.path}\u0000${right.fact_id}`));
}

function makeManifest(
  documents: readonly ImmutableDocument[],
  extractions: readonly ExtractionResult[],
  facts: readonly CanonicalFact[],
): readonly MultiDocumentManifestEntry[] {
  const extractionByDocument = new Map(extractions.map((entry) => [entry.document_id, entry] as const));
  const statuses = lineageStatuses(documents);
  return documents
    .map((document): MultiDocumentManifestEntry => {
      const extraction = extractionByDocument.get(document.document_id) ?? null;
      const extractionView = extraction === null
        ? null
        : (() => {
          const unsignedExtraction = {
            extraction_id: extraction.extraction_id,
            status: extraction.status,
            detected_document_type: extraction.detected_document_type,
            provider_id: extraction.provider.provider_id,
            extractor_version: extraction.provider.extractor_version,
            model_version: extraction.provider.model_version,
            raw_fields: extraction.fields
              .map((field) => ({ ...field, warning_flags: [...field.warning_flags].sort(compareStrings) }))
              .sort((left, right) => compareStrings(left.candidate_id, right.candidate_id)),
            raw_additional_components: extraction.additional_components
              .map((component) => ({ ...component, warning_flags: [...component.warning_flags].sort(compareStrings) }))
              .sort((left, right) => compareStrings(left.component_id, right.component_id)),
            identity_signal_hashes: uniqueSorted(
              extraction.sensitive_metadata.map((entry) => canonicalSha256({ kind: entry.kind, raw_value: entry.raw_value })),
            ),
          };
          return { ...unsignedExtraction, extraction_sha256: canonicalSha256(unsignedExtraction) };
        })();
      const unsigned = {
        document,
        supported_type: supportedType(document),
        lineage_status: statuses.get(document.document_id) ?? "current",
        extraction: extractionView,
        normalized_facts: normalizedFactsForDocument(document.document_id, facts),
      } as const;
      return deepFreeze({ ...unsigned, entry_sha256: canonicalSha256(unsigned) });
    })
    .sort((left, right) => compareStrings(left.document.document_id, right.document.document_id));
}

function detectLineageIssues(documents: readonly ImmutableDocument[]): readonly MultiDocumentTechnicalIssue[] {
  const issues: MultiDocumentTechnicalIssue[] = [];
  const byId = new Map(documents.map((entry) => [entry.document_id, entry] as const));
  const byContent = new Map<string, string[]>();
  for (const document of documents) {
    byContent.set(document.content_sha256, [...(byContent.get(document.content_sha256) ?? []), document.document_id]);
    if (document.supersedes_document_id !== null) {
      issues.push(issue("document.corrected", "warning", [document.document_id, document.supersedes_document_id]));
      if (!byId.has(document.supersedes_document_id)) {
        issues.push(issue("document.supersedes_missing", "blocker", [document.document_id, document.supersedes_document_id]));
      }
      const seen = new Set([document.document_id]);
      let cursor: ImmutableDocument | undefined = document;
      while (cursor && cursor.supersedes_document_id !== null) {
        if (seen.has(cursor.supersedes_document_id)) {
          issues.push(issue("document.supersedes_cycle", "blocker", [...seen, cursor.supersedes_document_id]));
          break;
        }
        seen.add(cursor.supersedes_document_id);
        cursor = byId.get(cursor.supersedes_document_id);
      }
    }
    if (supportedType(document) === "unsupported") {
      issues.push(issue("document.type_unsupported", "warning", [document.document_id]));
    }
  }
  for (const ids of byContent.values()) {
    if (ids.length > 1) issues.push(issue("document.duplicate_content", "warning", ids));
  }
  return issues;
}

function detectExtractionIssues(
  documents: readonly ImmutableDocument[],
  extractions: readonly ExtractionResult[],
): readonly MultiDocumentTechnicalIssue[] {
  const issues: MultiDocumentTechnicalIssue[] = [];
  const documentIds = new Set(documents.map((entry) => entry.document_id));
  const extractionByDocument = new Map(extractions.map((entry) => [entry.document_id, entry] as const));
  for (const document of documents) {
    const extraction = extractionByDocument.get(document.document_id);
    if (!extraction) {
      issues.push(issue("document.extraction_missing", "warning", [document.document_id]));
    } else if (extraction.status === "failed") {
      issues.push(issue("extraction.failed", "blocker", [document.document_id]));
    } else if (extraction.status === "partial") {
      issues.push(issue("extraction.partial", "warning", [document.document_id]));
    }
  }
  for (const extraction of extractions) {
    if (!documentIds.has(extraction.document_id)) {
      issues.push(issue("document.provenance_missing", "blocker", [extraction.document_id]));
    }
  }
  return issues;
}

function detectIdentityIssues(
  documents: readonly ImmutableDocument[],
  extractions: readonly ExtractionResult[],
): readonly MultiDocumentTechnicalIssue[] {
  const activeIds = new Set(
    documents
      .filter((candidate) => !documents.some((other) => other.supersedes_document_id === candidate.document_id))
      .map((entry) => entry.document_id),
  );
  const signals = new Map<string, Map<string, string[]>>();
  for (const extraction of extractions.filter((entry) => activeIds.has(entry.document_id))) {
    for (const entry of extraction.sensitive_metadata) {
      const hash = canonicalSha256({ kind: entry.kind, raw_value: entry.raw_value });
      const byHash = signals.get(entry.kind) ?? new Map<string, string[]>();
      byHash.set(hash, [...(byHash.get(hash) ?? []), extraction.document_id]);
      signals.set(entry.kind, byHash);
    }
  }
  const issues: MultiDocumentTechnicalIssue[] = [];
  for (const [kind, byHash] of signals) {
    if (byHash.size < 2) continue;
    const ids = [...byHash.values()].flat();
    issues.push(issue(kind === "employer_name" ? "employer.mismatch" : "identity.conflict", "blocker", ids));
  }
  return issues;
}

function detectFactIssues(
  documents: readonly ImmutableDocument[],
  facts: readonly CanonicalFact[],
): readonly MultiDocumentTechnicalIssue[] {
  const documentIds = new Set(documents.map((entry) => entry.document_id));
  const issues: MultiDocumentTechnicalIssue[] = [];
  for (const fact of facts) {
    const referenced = factDocumentIds(fact);
    const missing = referenced.filter((id) => !documentIds.has(id));
    if (missing.length > 0) issues.push(issue("fact.document_reference_missing", "blocker", missing, [fact.path]));
    if (fact.status === "conflicted") {
      issues.push(issue("fact.conflicted", "blocker", referenced, [fact.path]));
    }
  }
  return issues;
}

function detectPeriodIssues(
  documents: readonly ImmutableDocument[],
  facts: readonly CanonicalFact[],
  requiredPeriod: DateRange | null,
): readonly MultiDocumentTechnicalIssue[] {
  const active = documents.filter((candidate) => !documents.some((other) => other.supersedes_document_id === candidate.document_id));
  const dated = active.filter((entry): entry is ImmutableDocument & { document_period: DateRange } => entry.document_period !== null);
  const issues: MultiDocumentTechnicalIssue[] = [];
  for (let index = 0; index < dated.length; index += 1) {
    for (let other = index + 1; other < dated.length; other += 1) {
      const left = dated[index]!;
      const right = dated[other]!;
      if (left.document_type === right.document_type && rangesOverlap(left.document_period, right.document_period)) {
        issues.push(issue("period.overlap", "warning", [left.document_id, right.document_id], [], uniqueSorted([
          ...monthsInRange(left.document_period),
          ...monthsInRange(right.document_period),
        ])));
      }
    }
  }
  const payslipMonths = new Set(
    dated.filter((entry) => entry.document_type === "payslip").flatMap((entry) => monthsInRange(entry.document_period)),
  );
  if (requiredPeriod !== null || payslipMonths.size > 1) {
    const sorted = [...payslipMonths].sort(compareStrings);
    const complete = requiredPeriod === null
      ? monthsInRange({ start_date: `${sorted[0]}-01`, end_date: `${sorted.at(-1)}-28` })
      : monthsInRange(requiredPeriod);
    for (const month of complete) {
      if (!payslipMonths.has(month)) issues.push(issue("period.missing_month", "blocker", [], [], [month]));
    }
  }
  for (const companion of dated.filter((entry) => entry.document_type === "attendance" || entry.document_type === "pension_deposit")) {
    const missing = monthsInRange(companion.document_period).filter((month) => !payslipMonths.has(month));
    if (missing.length > 0) issues.push(issue("period.cross_document_gap", "warning", [companion.document_id], [], missing));
  }
  const terminationDocuments = dated.filter((entry) => entry.document_type === "termination");
  const endDateFact = facts.find((fact) => fact.path === "employment.end_date" && fact.status === "confirmed");
  if (endDateFact?.value && typeof endDateFact.value === "string") {
    for (const document of terminationDocuments) {
      const end = document.document_period.end_date ?? document.document_period.start_date;
      if (endDateFact.value < document.document_period.start_date || endDateFact.value > end) {
        issues.push(issue("termination.period_mismatch", "warning", [document.document_id], ["employment.end_date"]));
      }
    }
  }
  return issues;
}

function sortIssues(issues: readonly MultiDocumentTechnicalIssue[]): readonly MultiDocumentTechnicalIssue[] {
  const unique = new Map(issues.map((entry) => [entry.evidence_sha256, entry] as const));
  return [...unique.values()].sort((left, right) =>
    compareStrings(`${left.code}\u0000${left.evidence_sha256}`, `${right.code}\u0000${right.evidence_sha256}`),
  );
}

function makeTimeline(
  documents: readonly ImmutableDocument[],
  facts: readonly CanonicalFact[],
  issues: readonly MultiDocumentTechnicalIssue[],
  requiredPeriod: DateRange | null,
): readonly EmploymentTimelineMonth[] {
  const active = documents.filter((candidate) => !documents.some((other) => other.supersedes_document_id === candidate.document_id));
  const dated = active.filter((entry): entry is ImmutableDocument & { document_period: DateRange } => entry.document_period !== null);
  const observedMonths = uniqueSorted(dated.flatMap((entry) => monthsInRange(entry.document_period)));
  const months = requiredPeriod !== null
    ? monthsInRange(requiredPeriod)
    : observedMonths.length === 0
      ? []
      : monthsInRange({ start_date: `${observedMonths[0]}-01`, end_date: `${observedMonths.at(-1)}-28` });
  return months.map((periodKey) => {
    const monthDocuments = dated.filter((entry) => monthsInRange(entry.document_period).includes(periodKey));
    const monthIds = uniqueSorted(monthDocuments.map((entry) => entry.document_id));
    const factIds = uniqueSorted(
      facts
        .filter((fact) => factDocumentIds(fact).some((id) => monthIds.includes(id)))
        .map((fact) => fact.fact_id),
    );
    const issueCodes = uniqueSorted(
      issues
        .filter((entry) => entry.period_keys.includes(periodKey) || entry.document_ids.some((id) => monthIds.includes(id)))
        .map((entry) => entry.code),
    ) as readonly MultiDocumentTechnicalIssueCode[];
    const unsigned = {
      period_key: periodKey,
      active_document_ids: monthIds,
      active_document_types: uniqueSorted(monthDocuments.map((entry) => entry.document_type)),
      documented_fact_ids: factIds,
      issue_codes: issueCodes,
    };
    return deepFreeze({ ...unsigned, month_sha256: canonicalSha256(unsigned) });
  });
}

function mappingState(
  mapping: RuleInputMapping,
  fact: CanonicalFact | undefined,
  preparedAt: string,
  unreadable: boolean,
): RuleInputCoverageState {
  if (!fact || fact.status === "missing") return unreadable ? "unreadable" : "missing";
  if (fact.status === "conflicted") return "conflicted";
  if (fact.status === "candidate" || fact.status === "needs_confirmation") return "unconfirmed";
  if (fact.status === "rejected") return "rejected";
  const ageSeconds = (Date.parse(preparedAt) - Date.parse(fact.created_at)) / 1_000;
  if (ageSeconds > mapping.max_age_seconds || ageSeconds < 0) return "stale";
  if (fact.confidence < mapping.minimum_confidence) return "below_confidence";
  return "covered";
}

function scopeHasUnreadableDocument(scope: RuleInputScopeRequirement, manifest: readonly MultiDocumentManifestEntry[]): boolean {
  return manifest.some((entry) =>
    entry.document.document_period !== null
    && rangesOverlap(entry.document.document_period, scope.period)
    && (entry.extraction?.status === "failed" || entry.extraction?.status === "partial"),
  );
}

function makeRuleInputViews(
  scopes: readonly RuleInputScopeRequirement[],
  registry: RegisteredRuleInputMappingRegistry,
  factSnapshot: EmploymentSnapshot,
  manifest: readonly MultiDocumentManifestEntry[],
  manifestSha256: string,
  preparedAt: string,
): readonly ScopedRuleInputView[] {
  const mappings = new Map(registry.registry.mappings.map((entry) => [entry.input_id, entry] as const));
  const facts = new Map(factSnapshot.facts.map((entry) => [entry.path, entry] as const));
  return scopes
    .map((scope): ScopedRuleInputView => {
      const unreadable = scopeHasUnreadableDocument(scope, manifest);
      const coverage = scope.input_ids
        .map((inputId) => {
          const mapping = mappings.get(inputId);
          if (!mapping) throw new Error(`multi_document_mapping_missing:${inputId}`);
          const fact = facts.get(mapping.fact_path);
          return {
            input_id: inputId,
            fact_path: mapping.fact_path,
            state: mappingState(mapping, fact, preparedAt, unreadable),
            fact_id: fact?.fact_id ?? null,
            provenance_sha256: fact ? canonicalSha256(fact.provenance) : null,
          };
        })
        .sort((left, right) => compareStrings(left.input_id, right.input_id));
      const blockerCodes = uniqueSorted(coverage.filter((entry) => entry.state !== "covered").map((entry) => `rule_input.${entry.state}`));
      const coverageSeed = {
        scope,
        coverage,
        blocker_codes: blockerCodes,
        mapping_registry_sha256: registry.registry_sha256,
        fact_snapshot_sha256: canonicalSha256(factSnapshot),
        manifest_sha256: manifestSha256,
      };
      const coverageSha256 = canonicalSha256(coverageSeed);
      const snapshot = ruleInputSnapshotSchema.parse({
        snapshot_id: `scope:${canonicalSha256({ scope_id: scope.scope_id, coverage_sha256: coverageSha256 })}`,
        snapshot_version: "multi-document:1.0.0",
        snapshot_sha256: coverageSha256,
      });
      return deepFreeze({ scope, snapshot, coverage, blocker_codes: blockerCodes, coverage_sha256: coverageSha256 });
    })
    .sort((left, right) => compareStrings(left.scope.scope_id, right.scope.scope_id));
}

function makeClarificationDependencies(
  factSnapshot: EmploymentSnapshot,
  registry: RegisteredRuleInputMappingRegistry,
  scopes: readonly RuleInputScopeRequirement[],
): Readonly<{
  facts: readonly ClarificationFactState[];
  requirements: readonly DeclaredRuleInputRequirement[];
}> {
  const factByPath = new Map(factSnapshot.facts.map((entry) => [entry.path, entry] as const));
  const mappings = new Map(registry.registry.mappings.map((entry) => [entry.input_id, entry] as const));
  const requestedPaths = new Set<FactPath>();
  const requirements: DeclaredRuleInputRequirement[] = [];
  for (const scope of scopes) {
    for (const inputId of scope.input_ids) {
      const mapping = mappings.get(inputId);
      if (!mapping) throw new Error(`multi_document_mapping_missing:${inputId}`);
      const fact = factByPath.get(mapping.fact_path);
      if (fact && fact.status !== "missing" && fact.status !== "conflicted") continue;
      requestedPaths.add(mapping.fact_path);
      const unsigned = {
        requirement_id: `requirement:${scope.scope_id}:${inputId}`,
        requirement_version: registry.registry.registry_version,
        fact_path: mapping.fact_path,
        scope_sha256: canonicalSha256(scope),
        registry_sha256: registry.registry_sha256,
      };
      requirements.push(deepFreeze({
        requirement_id: unsigned.requirement_id,
        requirement_version: unsigned.requirement_version,
        fact_path: unsigned.fact_path,
        requirement_sha256: canonicalSha256(unsigned),
      }));
    }
  }
  const facts = [...requestedPaths]
    .sort(compareStrings)
    .map((path): ClarificationFactState => {
      const fact = factByPath.get(path);
      const status = fact?.status === "conflicted" ? "conflicted" : "missing";
      const factIds = status === "conflicted" ? uniqueSorted([fact!.fact_id, ...fact!.conflicting_fact_ids]) : [];
      const unsigned = { fact_path: path, status, fact_ids: factIds } as const;
      return deepFreeze({ ...unsigned, state_sha256: canonicalSha256(unsigned) });
    });
  return {
    facts,
    requirements: requirements.sort((left, right) => compareStrings(left.requirement_id, right.requirement_id)),
  };
}

/**
 * Builds a deterministic technical intake projection over the canonical
 * Document, Extraction, Fact and Snapshot models. It intentionally makes no
 * legal classification and computes no monetary entitlement.
 */
export function buildMultiDocumentIntake(input: MultiDocumentIntakeInput): MultiDocumentIntakeResult {
  const { documents, extractions, factSnapshot, registry, scopes, preparedAt, requiredPeriod } = validateInput(input);
  const manifest = makeManifest(documents, extractions, factSnapshot.facts);
  const manifestSha256 = canonicalSha256(manifest);
  const technicalIssues = sortIssues([
    ...detectLineageIssues(documents),
    ...detectExtractionIssues(documents, extractions),
    ...detectIdentityIssues(documents, extractions),
    ...detectFactIssues(documents, factSnapshot.facts),
    ...detectPeriodIssues(documents, factSnapshot.facts, requiredPeriod),
  ]);
  const timeline = makeTimeline(documents, factSnapshot.facts, technicalIssues, requiredPeriod);
  const timelineSha256 = canonicalSha256(timeline);
  const clarifications = makeClarificationDependencies(factSnapshot, registry, scopes);
  const ruleInputViews = makeRuleInputViews(scopes, registry, factSnapshot, manifest, manifestSha256, preparedAt);
  const retainedWarningCodes = uniqueSorted([
    ...(input.prior_warning_codes ?? []),
    ...technicalIssues.map((entry) => entry.code),
    ...ruleInputViews.flatMap((entry) => entry.blocker_codes),
  ]);
  const unsigned = {
    schema_version: "tivdoc-multi-document-intake-v0.10.0" as const,
    case_id: input.case_id,
    manifest,
    manifest_sha256: manifestSha256,
    timeline,
    timeline_sha256: timelineSha256,
    technical_issues: technicalIssues,
    clarification_fact_states: clarifications.facts,
    declared_rule_input_requirements: clarifications.requirements,
    rule_input_views: ruleInputViews,
    retained_warning_codes: retainedWarningCodes,
  };
  return deepFreeze({ ...unsigned, result_sha256: canonicalSha256(unsigned) });
}

/** A canonical ordering witness useful for independent locale/timezone checks. */
export function multiDocumentIntakeCanonicalBytes(result: MultiDocumentIntakeResult): string {
  return canonicalStringify(result);
}
