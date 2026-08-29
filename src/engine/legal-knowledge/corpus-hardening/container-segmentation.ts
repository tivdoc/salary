import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const containerKindSchema = z.enum([
  "gazette",
  "amendment_publication",
  "permit_attachment",
]);

export const instrumentSegmentSchema = z.object({
  contract_version: z.literal("instrument-container-segmentation-v0.4"),
  container_kind: containerKindSchema,
  container_artifact_sha256: sha256Schema,
  container_page_count: z.number().int().positive(),
  source_version_id: z.string().min(3),
  instrument_id: z.string().min(3),
  instrument_review_state: z.literal("needs_review"),
  activation_state: z.literal("inactive"),
  page_from: z.number().int().positive(),
  page_to: z.number().int().positive(),
  included_section_ids: z.array(z.string().min(1)).min(1).readonly(),
  start_locator: z.string().min(1),
  end_locator: z.string().min(1),
  partial_boundary_pages: z.array(z.number().int().positive()).readonly(),
  legal_effect_interpreted: z.literal(false),
  unrelated_container_text_retrievable: z.literal(false),
}).strict().superRefine((segment, context) => {
  if (segment.page_from > segment.page_to || segment.page_to > segment.container_page_count) {
    context.addIssue({ code: "custom", message: "segment_page_range_invalid" });
  }
  for (const page of segment.partial_boundary_pages) {
    if (page < segment.page_from || page > segment.page_to) context.addIssue({ code: "custom", message: "partial_page_outside_segment" });
  }
}).readonly();

export type InstrumentSegment = z.infer<typeof instrumentSegmentSchema>;

export type ContainerChunk = Readonly<{
  chunk_id: string;
  container_artifact_sha256: string;
  page: number;
  section_id: string;
  text: string;
}>;

export const CONVALESCENCE_2025_SEGMENT = instrumentSegmentSchema.parse({
  contract_version: "instrument-container-segmentation-v0.4",
  container_kind: "gazette",
  container_artifact_sha256: "eba7e1fa570a3ece265d87f379543024da038ee51af3f959d4c74162f5edecfa",
  container_page_count: 40,
  source_version_id: "IL_CONVALESCENCE_REDUCTION_FREEZE_LAW_2025@discovery-v0.3.1",
  instrument_id: "GAZETTE-3384:CHAPTER-7:SECTION-24",
  instrument_review_state: "needs_review",
  activation_state: "inactive",
  page_from: 16,
  page_to: 25,
  included_section_ids: ["chapter-7.section-24"],
  start_locator: "page 16 heading: Chapter 7 - freeze and reduction of convalescence pay in 2025; section 24",
  end_locator: "page 25 immediately before Chapter 8 - Pensions; section 25",
  partial_boundary_pages: [16, 25],
  legal_effect_interpreted: false,
  unrelated_container_text_retrievable: false,
});

export function createInstrumentContainerContract(input: Omit<InstrumentSegment, "contract_version" | "instrument_review_state" | "activation_state" | "legal_effect_interpreted" | "unrelated_container_text_retrievable">) {
  return instrumentSegmentSchema.parse({
    ...input,
    contract_version: "instrument-container-segmentation-v0.4",
    instrument_review_state: "needs_review",
    activation_state: "inactive",
    legal_effect_interpreted: false,
    unrelated_container_text_retrievable: false,
  });
}

/** Retrieval must receive instrument-labelled chunks; page overlap alone is insufficient on mixed pages. */
export function selectInstrumentChunks(segmentInput: InstrumentSegment, chunks: readonly ContainerChunk[]) {
  const segment = instrumentSegmentSchema.parse(segmentInput);
  const allowedSections = new Set(segment.included_section_ids);
  return chunks
    .filter((chunk) => (
      chunk.container_artifact_sha256 === segment.container_artifact_sha256
      && chunk.page >= segment.page_from
      && chunk.page <= segment.page_to
      && allowedSections.has(chunk.section_id)
    ))
    .sort((left, right) => left.page - right.page || left.chunk_id.localeCompare(right.chunk_id));
}
