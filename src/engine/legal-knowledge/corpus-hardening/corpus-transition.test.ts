import { describe, expect, it } from "vitest";
import { buildConvalescenceChunkTransition, buildCorpusSourceTransitionLedger, buildNetChunkDeltaLedger, type CorpusBuildRecord, type TransitionChunk } from "./corpus-transition.ts";
import type { CorpusRoleAssignment } from "./source-roles.ts";

const chunk = (id: string, page: number, hash = id.padEnd(64, "0").slice(0, 64)): TransitionChunk => ({ chunk_id: id, chunk_text_sha256: hash, page_from: page, page_to: page });

describe("corpus transition evidence", () => {
  it("freezes exactly 17 source transitions while keeping every lifecycle dimension separate", () => {
    const role: CorpusRoleAssignment = { source_version_id: "SYN_SOURCE@v1", artifact_id: null, role: "binding_operative_instrument_version", lifecycle: "registered_candidate", eligible_for_operative_resolution: true, eligible_to_independently_support_monetary_parameter: false, reason_codes: ["synthetic_fixture"] };
    const records = (after: boolean): CorpusBuildRecord[] => Array.from({ length: 17 }, (_, index) => {
      const failed = after ? index >= 14 : index === 16;
      const chunkCount = failed ? 0 : index === 0 ? (after ? 189 : 259) : 1;
      return { source_id: `SYN_SOURCE_${index + 1}`, source_version: "v1", artifact_sha256: String(index + 1).padStart(64, "0"), acquisition_status: "acquired", parse_status: failed ? "parse_failed" : "parsed", safe_error_code: failed ? "synthetic_fail_closed" : null, chunk_count: chunkCount, chunk_ids: Array.from({ length: chunkCount }, (_, chunkIndex) => `SYN_SOURCE_${index + 1}@v1#${chunkIndex + 1}`), citation_status: "unverified", interval_status: "unverified", sector_status: "unverified", population_status: "unverified", review_status: "needs_review", activation_status: "inactive", role: { ...role, source_version_id: `SYN_SOURCE_${index + 1}@v1` } };
    });
    const ledger = buildCorpusSourceTransitionLedger(records(false), records(true));
    expect(ledger.entries).toHaveLength(17);
    expect(ledger.counts).toEqual({ before: { parsed: 16, failed: 1, chunks: 274 }, after: { parsed: 14, failed: 3, chunks: 202 }, chunk_delta: -72 });
    expect(Object.keys(ledger.entries[0])).toEqual(["transition_id", "source_version_id", "role_candidate", "acquisition", "parse", "segmentation", "source_role", "explanatory_or_corroborative_retrieval", "operative_resolution", "citation", "effective_interval", "sector", "population", "review", "activation", "transition_reason_codes"]);
  });

  it("accounts for all 65 old chunks, positive coverage, negative leakage, boundaries, and the full 72 delta", () => {
    // Force exactly 53 outside, 9 exact inner mappings and 3 boundary mappings.
    const inside = [
      chunk("old-01", 16), chunk("old-02", 25), chunk("old-03", 25),
      ...Array.from({ length: 9 }, (_, index) => chunk(`old-${String(index + 4).padStart(2, "0")}`, 17 + Math.min(index, 7))),
    ];
    const outside = Array.from({ length: 53 }, (_, index) => chunk(`outside-${index + 1}`, index < 15 ? index + 1 : 26 + (index % 15)));
    const old65 = [...inside, ...outside];
    const new11 = [chunk("new-boundary-16", 16), chunk("new-boundary-25", 25), ...inside.slice(3).map((entry, index) => chunk(`new-exact-${index + 1}`, entry.page_from, entry.chunk_text_sha256))];
    const transition = buildConvalescenceChunkTransition(old65, new11);
    expect(transition.mappings).toHaveLength(65);
    expect(transition.counts).toMatchObject({ stable_text: 9, excluded_outside_instrument: 53, boundary_old_chunks: 3, boundary_new_chunks: 2, net_delta: -54 });
    expect(transition.positive_provision_completeness.passed).toBe(true);
    expect(transition.negative_leakage.passed).toBe(true);
    expect(transition.boundary_evidence.every((entry) => entry.review_state === "needs_review")).toBe(true);
  });

  it("reconciles the extra 18 selector-boundary chunks into 72 stable delta IDs", () => {
    const boundaries = [chunk("old-boundary-16", 16), chunk("old-boundary-25a", 25), chunk("old-boundary-25b", 25)];
    const stable = Array.from({ length: 9 }, (_, index) => chunk(`stable-${index}`, 17 + Math.min(index, 7)));
    const outside = Array.from({ length: 53 }, (_, index) => chunk(`outside-${index}`, index < 15 ? index + 1 : 26 + (index % 15)));
    const newChunks = [chunk("new-16", 16), chunk("new-25", 25), ...stable.map((entry, index) => chunk(`new-${index}`, entry.page_from, entry.chunk_text_sha256))];
    const convalescence = buildConvalescenceChunkTransition([...boundaries, ...stable, ...outside], newChunks);
    const ledger = buildNetChunkDeltaLedger({
      convalescence,
      permitOldChunks: Array.from({ length: 12 }, (_, index) => chunk(`permit-${index}`, 1)),
      attachmentOldChunks: Array.from({ length: 6 }, (_, index) => chunk(`attachment-${index}`, 1)),
    });
    expect(ledger.records).toHaveLength(72);
    expect(ledger.records[0].delta_id).toBe("CHUNK_TRANSITION_001");
    expect(ledger.records.at(-1)?.delta_id).toBe("CHUNK_TRANSITION_072");
    expect(ledger).toMatchObject({ total_delta: -72, extra_selector_delta: -18 });
  });
});
