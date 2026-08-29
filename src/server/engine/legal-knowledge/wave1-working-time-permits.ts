import { z } from "zod";

const httpsUrlSchema = z.string().url().refine((value) => value.startsWith("https://"), "https_required");
const isoTimestampSchema = z.string().datetime({ offset: true });
const inactiveReviewSchema = z.object({
  review_state: z.literal("needs_review"),
  activation_state: z.literal("inactive"),
}).strict();

const artifactLinkSchema = z.object({
  artifact_id: z.string().min(1),
  title: z.string().min(1),
  official_url: httpsUrlSchema,
  artifact_status: z.literal("official_link_observed_not_acquired"),
}).strict();

export const workingTimePermitCatalogEntrySchema = z.object({
  catalog_ordinal: z.number().int().min(1).max(58),
  page: z.number().int().min(1).max(6),
  page_item: z.number().int().min(1).max(10),
  stable_id: z.string().startsWith("GOVIL-WORK-PERMIT:"),
  catalog_title: z.string().min(1),
  topic_label: z.string().min(1),
  catalog_url: httpsUrlSchema,
  artifact_links: z.array(artifactLinkSchema).min(1),
  relevance: z.literal("unknown_pending_legal_review"),
  discovery_evidence: z.string().startsWith("public_visible_catalog_page_"),
  applicability_claimed: z.literal(false),
  expiry_claimed: z.literal(false),
  revocation_claimed: z.literal(false),
  sector_coverage_claimed: z.literal(false),
  duplicate_title: z.boolean(),
}).strict();

const permitSnapshotSchema = z.object({
  catalog_id: z.literal("IL_WORK_PERMITS_CATALOG"),
  canonical_url: httpsUrlSchema,
  observed_at: isoTimestampSchema,
  acquisition_method: z.literal("public_browser_visible_navigation"),
  filters: z.object({ topic: z.literal("none"), title: z.literal(""), from_date: z.null(), to_date: z.null() }).strict(),
  reported_result_count: z.literal(58),
  observed_entry_count: z.literal(58),
  status: z.literal("complete"),
  cutoff: isoTimestampSchema,
  pages: z.array(z.object({
    page: z.number().int().min(1).max(6),
    skip: z.number().int().nonnegative(),
    url: httpsUrlSchema,
    entries_observed: z.number().int().min(1).max(10),
  }).strict()).length(6),
  stable_id_method: z.string().min(1),
  artifact_link_count: z.literal(68),
  unique_artifact_url_count: z.literal(68),
  duplicate_stable_ids: z.array(z.never()).length(0),
  duplicate_artifact_urls: z.array(z.never()).length(0),
  duplicate_catalog_titles: z.array(z.object({ title: z.string().min(1), count: z.literal(2) }).strict()).length(3),
  catalog_entries_are_discovery_evidence_only: z.literal(true),
  artifact_acquisition_results_location: z.string().min(1),
}).strict();

export const workingTimePermitsCatalogSchema = z.object({
  schema_version: z.literal("wave1-working-time-permits-catalog-v0.3"),
  snapshot: permitSnapshotSchema,
  entries: z.array(workingTimePermitCatalogEntrySchema).length(58),
}).strict();

const publicationKindSchema = z.enum([
  "original_promulgation",
  "direct_amendment_publication",
  "indirect_amendment_publication",
  "error_correction_publication",
]);

export const hoursPublicationEntrySchema = z.object({
  publication_ordinal: z.number().int().min(1).max(20),
  publication_identity: z.string().startsWith("KNESSET:HOURS-WORK-REST:"),
  amendment_number: z.string().regex(/^([1-9]|1[0-8])$/).nullable(),
  publication_kind: publicationKindSchema,
  catalog_directness: z.enum(["ישיר", "עקיף"]).nullable(),
  title: z.string().min(1),
  publication_series: z.literal("ספר החוקים"),
  publication_issue: z.string().regex(/^\d+$/),
  publication_page: z.string().regex(/^\d+$/),
  publication_date: z.string().date(),
  official_detail_url: httpsUrlSchema,
  official_artifact_url: httpsUrlSchema,
  artifact_status: z.literal("official_pdf_link_observed_pending_acquisition"),
  artifact_role: z.enum(["original_promulgation", "amendment_publication", "error_correction_publication"]),
  discovery_evidence: z.string().startsWith("public_visible_knesset_law_page_row_"),
  consolidated_text_created: z.literal(false),
  applicability_claimed: z.literal(false),
  effectivity_claimed: z.literal(false),
  relations_claimed: z.literal(false),
}).merge(inactiveReviewSchema).strict();

const hoursSnapshotSchema = z.object({
  catalog_id: z.literal("IL_HOURS_WORK_REST_LAW_PUBLICATIONS"),
  canonical_url: httpsUrlSchema,
  observed_at: isoTimestampSchema,
  acquisition_method: z.literal("public_browser_visible_navigation"),
  query: z.object({ law_id: z.literal("2000019"), visible_control: z.literal("load_more_once") }).strict(),
  reported_result_count: z.literal(20),
  observed_entry_count: z.literal(20),
  status: z.literal("complete_publication_inventory"),
  pages_observed: z.literal(2),
  artifact_link_count: z.literal(20),
  original_detail_evidence_url: httpsUrlSchema,
  institutional_consolidated_representation_observed: z.literal(false),
  external_non_official_full_text_link_excluded: httpsUrlSchema,
  consolidated_text_created: z.literal(false),
  artifact_acquisition_results_location: z.string().min(1),
}).strict();

export const hoursPublicationsInventorySchema = z.object({
  schema_version: z.literal("wave1-working-time-permits-publications-v0.3"),
  snapshot: hoursSnapshotSchema,
  entries: z.array(hoursPublicationEntrySchema).length(20),
}).strict();

function assertUnique(values: readonly string[], code: string) {
  if (new Set(values).size !== values.length) throw new Error(code);
}

function assertOfficialUrl(url: string, allowedHosts: readonly string[], code: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) throw new Error(code);
}

export function validateWorkingTimePermitInventories(input: { permits: unknown; publications: unknown }) {
  const permits = workingTimePermitsCatalogSchema.parse(input.permits);
  const publications = hoursPublicationsInventorySchema.parse(input.publications);

  assertUnique(permits.entries.map((entry) => entry.stable_id), "duplicate_permit_stable_id");
  assertUnique(permits.entries.map((entry) => String(entry.catalog_ordinal)), "duplicate_permit_ordinal");
  const permitArtifacts = permits.entries.flatMap((entry) => entry.artifact_links);
  assertUnique(permitArtifacts.map((artifact) => artifact.artifact_id), "duplicate_permit_artifact_id");
  assertUnique(permitArtifacts.map((artifact) => artifact.official_url), "duplicate_permit_artifact_url");
  for (const artifact of permitArtifacts) assertOfficialUrl(artifact.official_url, ["www.gov.il"], "permit_artifact_host_not_official");
  for (const entry of permits.entries) assertOfficialUrl(entry.catalog_url, ["www.gov.il"], "permit_catalog_host_not_official");

  assertUnique(publications.entries.map((entry) => entry.publication_identity), "duplicate_publication_identity");
  assertUnique(publications.entries.map((entry) => String(entry.publication_ordinal)), "duplicate_publication_ordinal");
  assertUnique(publications.entries.map((entry) => entry.official_artifact_url), "duplicate_publication_artifact_url");
  for (const entry of publications.entries) {
    assertOfficialUrl(entry.official_detail_url, ["main.knesset.gov.il"], "publication_detail_host_not_official");
    assertOfficialUrl(entry.official_artifact_url, ["fs.knesset.gov.il"], "publication_artifact_host_not_official");
  }

  const pageCounts = new Map<number, number>();
  for (const entry of permits.entries) pageCounts.set(entry.page, (pageCounts.get(entry.page) ?? 0) + 1);
  const expectedPageCounts = [10, 10, 10, 10, 10, 8];
  if (expectedPageCounts.some((expected, index) => pageCounts.get(index + 1) !== expected)) throw new Error("permit_pagination_incomplete");
  if (permitArtifacts.length !== 68) throw new Error("permit_artifact_link_inventory_incomplete");

  const publicationKinds = publications.entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.publication_kind] = (counts[entry.publication_kind] ?? 0) + 1;
    return counts;
  }, {});
  if (publicationKinds.original_promulgation !== 1 || publicationKinds.error_correction_publication !== 1) throw new Error("hours_original_or_correction_missing");
  if ((publicationKinds.direct_amendment_publication ?? 0) + (publicationKinds.indirect_amendment_publication ?? 0) !== 18) throw new Error("hours_amendment_inventory_incomplete");

  return { permits, publications, permitArtifacts, publicationKinds };
}

export function summarizeWorkingTimePermitInventories(permits: unknown, publications: unknown) {
  const validated = validateWorkingTimePermitInventories({ permits, publications });
  return {
    hours_publications: validated.publications.entries.length,
    hours_artifact_links: validated.publications.entries.length,
    permit_catalog_entries: validated.permits.entries.length,
    permit_artifact_links: validated.permitArtifacts.length,
    permit_pages: validated.permits.snapshot.pages.length,
    duplicate_catalog_title_groups: validated.permits.snapshot.duplicate_catalog_titles.length,
    review_state: "needs_review" as const,
    activation_state: "inactive" as const,
    applicability_inferred: false as const,
    consolidated_text_created: false as const,
  };
}

export type ArtifactAcquisitionFailure = {
  artifact_id: string;
  official_url: string;
  safe_error_code: string;
};

export function buildWorkingTimePermitOwnerHandoff(input: {
  missingCatalogOrdinals?: readonly number[];
  artifactFailures?: readonly ArtifactAcquisitionFailure[];
}) {
  const missingCatalogOrdinals = [...(input.missingCatalogOrdinals ?? [])].sort((a, b) => a - b);
  const artifactFailures = [...(input.artifactFailures ?? [])].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));
  return {
    request_id: "ACQ-WAVE1-WORKING-TIME-PERMITS",
    status: missingCatalogOrdinals.length === 0 && artifactFailures.length === 0 ? "not_required" : "owner_action_required",
    canonical_catalog_url: "https://www.gov.il/he/Departments/DynamicCollectors/work-permits",
    required_catalog_count: 58,
    missing_catalog_ordinals: missingCatalogOrdinals,
    artifact_failures: artifactFailures,
    exact_steps: [
      "Open the canonical catalog URL in a normal public browser without login, cookies, CAPTCHA solving, proxying, header manipulation, or internal APIs.",
      "Keep all filters empty and record the visible reported result count.",
      "Traverse visible pages 1 through 6 and match every row by its BlobFolder dynamiccollectorresultitem slug; do not infer relevance from titles.",
      "For each failed artifact, open only its exact official_url and save the unchanged original PDF; do not print, convert, copy/paste, email, or use a mirror.",
      "Record final URL, observed time, original filename, SHA-256 and byte count; keep each artifact separate and mark relevance unknown_pending_legal_review.",
    ],
    prohibited_inferences: ["applicability", "expiry", "revocation", "sector_coverage", "relations", "consolidation"],
  } as const;
}
