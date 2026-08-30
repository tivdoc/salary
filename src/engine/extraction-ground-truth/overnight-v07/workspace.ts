import type { GroundTruthManifest } from "../../wave2/contracts.ts";
import { canonicalSha256, deepFreeze } from "../../rule-runtime/canonical.ts";
import { buildSyntheticGroundTruthWorkflow, SYNTHETIC_DOCUMENT_SHA256 } from "../synthetic-fixtures.ts";
import { assertLockedGroundTruthUnchanged } from "../workflow.ts";
import { validateGroundTruthManifest } from "../validation.ts";

export const GT_WORKSPACE_SCHEMA = "tivdoc-offline-gt-workspace-v0.7.0" as const;

export type FixtureProvenance = Readonly<{
  fixture_id: string;
  classification: "deterministic_synthetic" | "approved_public_non_identifying";
  reusable: boolean;
  provenance_uri: string | null;
  approval_sha256: string | null;
  customer_material: false;
}>;

export type ExistingPublicBenchmarkInventory = Readonly<{
  collection_id: "real-public-benchmark-v2.1";
  declared_neutral_fixture_count: 5;
  reuse_status: "excluded_pending_explicit_approval";
  fixture_bytes_read_by_p4: 0;
  identifying_content_revalidated_by_p4: false;
}>;

export type OfflineGroundTruthWorkspace = Readonly<{
  schema_version: typeof GT_WORKSPACE_SCHEMA;
  workspace_id: string;
  workspace_version: "0.7.0";
  execution_mode: "offline";
  document_seal: Readonly<{
    document_sha256: string;
    page_sha256: readonly string[];
    section_sha256: readonly Readonly<{ section_id: string; sha256: string }>[];
    immutable: true;
  }>;
  provenance: FixtureProvenance;
  workflow: Readonly<{
    annotation_1: GroundTruthManifest;
    annotation_2: GroundTruthManifest;
    disagreement: GroundTruthManifest;
    human_adjudication: GroundTruthManifest;
    locked_ground_truth: GroundTruthManifest;
  }>;
  candidate_comparison_policy: Readonly<{
    candidate_may_generate_annotation: false;
    earliest_visibility: "after_annotation_1_sealed";
    view: "separate_candidate_comparison";
  }>;
  field_contract: readonly Readonly<{
    field_identity: string;
    value_kind: string;
    presence: "present";
    readability: "readable";
    conflict_state: "agreement" | "disagreement_resolved";
    page: number;
    section: string;
    evidence_sha256: string;
  }>[];
  version_history_sha256: string;
  workspace_sha256: string;
}>;

export function syntheticFixtureProvenanceInventory(): readonly FixtureProvenance[] {
  return deepFreeze([{
    fixture_id: "synthetic.gt.fixture.v07",
    classification: "deterministic_synthetic" as const,
    reusable: true,
    provenance_uri: null,
    approval_sha256: null,
    customer_material: false as const,
  }]);
}

export function existingPublicBenchmarkProvenanceInventory(): readonly ExistingPublicBenchmarkInventory[] {
  return deepFreeze([{
    collection_id: "real-public-benchmark-v2.1" as const,
    declared_neutral_fixture_count: 5 as const,
    reuse_status: "excluded_pending_explicit_approval" as const,
    fixture_bytes_read_by_p4: 0 as const,
    identifying_content_revalidated_by_p4: false as const,
  }]);
}

export function buildOfflineGroundTruthWorkspace(): OfflineGroundTruthWorkspace {
  const workflow = buildSyntheticGroundTruthWorkflow();
  for (const manifest of Object.values(workflow)) validateGroundTruthManifest(manifest);
  const pageSha = canonicalSha256({ fixture: "synthetic.gt.fixture.v07", page: 1, document_sha256: SYNTHETIC_DOCUMENT_SHA256 });
  const sectionSha = canonicalSha256({ section_id: "synthetic.section", page_from: 1, page_to: 1, page_sha256: pageSha });
  const first = new Map(workflow.annotation_1.annotations.map((item) => [item.field_identity, item]));
  const second = new Map(workflow.annotation_2.annotations.filter((item) => item.annotation_pass === "annotation_2").map((item) => [item.field_identity, item]));
  const adjudicated = workflow.locked_ground_truth.annotations.filter((item) => item.annotation_pass === "human_adjudication");
  const fieldContract = adjudicated.map((item) => ({
    field_identity: item.field_identity,
    value_kind: item.value.kind,
    presence: "present" as const,
    readability: "readable" as const,
    conflict_state: canonicalSha256(first.get(item.field_identity)?.value) === canonicalSha256(second.get(item.field_identity)?.value) ? "agreement" as const : "disagreement_resolved" as const,
    page: item.page,
    section: item.section,
    evidence_sha256: canonicalSha256({ document_sha256: item.document_sha256, page: item.page, section: item.section, bounding_box: item.bounding_box }),
  })).sort((a, b) => a.field_identity.localeCompare(b.field_identity, "en"));
  const history = [workflow.annotation_1, workflow.annotation_2, workflow.disagreement, workflow.human_adjudication, workflow.locked_ground_truth];
  const payload = {
    schema_version: GT_WORKSPACE_SCHEMA,
    workspace_id: "synthetic.gt.workspace.v07",
    workspace_version: "0.7.0" as const,
    execution_mode: "offline" as const,
    document_seal: { document_sha256: SYNTHETIC_DOCUMENT_SHA256, page_sha256: [pageSha], section_sha256: [{ section_id: "synthetic.section", sha256: sectionSha }], immutable: true as const },
    provenance: syntheticFixtureProvenanceInventory()[0],
    workflow,
    candidate_comparison_policy: { candidate_may_generate_annotation: false as const, earliest_visibility: "after_annotation_1_sealed" as const, view: "separate_candidate_comparison" as const },
    field_contract: fieldContract,
    version_history_sha256: canonicalSha256(history),
  };
  return deepFreeze({ ...payload, workspace_sha256: canonicalSha256(payload) }) as OfflineGroundTruthWorkspace;
}

export function assertCandidateComparisonAllowed(input: Readonly<{ manifest: GroundTruthManifest; view: string }>): void {
  const manifest = validateGroundTruthManifest(input.manifest);
  if (manifest.status === "annotation_1" && manifest.annotations.length === 0) throw new Error("GT_CANDIDATE_HIDDEN_UNTIL_ANNOTATION_SEALED");
  if (input.view !== "separate_candidate_comparison") throw new Error("GT_CANDIDATE_COMPARISON_VIEW_NOT_SEPARATED");
}

export function assertWorkspaceLockedMutationDenied(workspace: OfflineGroundTruthWorkspace): void {
  const locked = workspace.workflow.locked_ground_truth;
  assertLockedGroundTruthUnchanged(locked, { ...locked, revision_reason: "mutation forbidden" });
}
