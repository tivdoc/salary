// L5-5 / D4. The selector, on synthetic pages shaped like a gazette issue.
import { describe, expect, it } from "vitest";
import { END_OF_ARTIFACT, selectedPages, selectInstrument } from "./instrument-selector-v1.ts";

const PAGES = [
  { page: 1, text: ["רשומות", "ילקוט הפרסומים", "צו הרחבה בדבר עניין ראשון 120", "הודעה על עניין שני 121"].join("\n") },
  { page: 2, text: ["צו הרחבה בדבר עניין ראשון", "1. הוראה ראשונה", "2. הוראה שנייה"].join("\n") },
  { page: 3, text: ["3. הוראה שלישית 418 שקלים חדשים", "הודעה על עניין שני", "1. הודעה"].join("\n") },
];
const BASE = { selection_id: "selection.synthetic.first", source_id: "SYNTHETIC_GAZETTE", source_version: "test-v0", artifact_sha256: "a".repeat(64), pages: PAGES };

describe("legal-instrument-selector-v1", () => {
  it("selects the page span from the instrument's title line to the next instrument's title line", () => {
    const outcome = selectInstrument({ ...BASE, start_anchor: "צו הרחבה בדבר עניין ראשון", end_anchor: "הודעה על עניין שני" });
    expect(outcome.refusal).toBeNull();
    expect(outcome.selection).toMatchObject({
      page_from: 2, page_to: 3,
      start_anchor_at: { page: 2, line: 0, character_from: 0 },
      end_anchor_at: { page: 3, line: 1 },
    });
    // The hash is over exactly the selected pages, and recomputing it agrees.
    expect(selectedPages(outcome.selection!, PAGES).map((page) => page.page)).toEqual([2, 3]);
  });

  it("runs to the end of the artifact when told to", () => {
    const outcome = selectInstrument({ ...BASE, start_anchor: "צו הרחבה בדבר עניין ראשון", end_anchor: END_OF_ARTIFACT });
    expect(outcome.selection?.page_to).toBe(3);
    expect(outcome.selection?.end_anchor_at).toBeNull();
  });

  it("refuses a title that is not a whole stored line, occurs twice, or comes after its end", () => {
    expect(selectInstrument({ ...BASE, start_anchor: "צו הרחבה בדבר עניין", end_anchor: END_OF_ARTIFACT }).refusal).toBe("SELECTION_START_ANCHOR_NOT_FOUND");
    // The TOC line and the body line are different strings here; a title that
    // appears twice verbatim would be ambiguous and refuses.
    const twice = { ...BASE, pages: [PAGES[1], PAGES[1]] };
    expect(selectInstrument({ ...twice, start_anchor: "צו הרחבה בדבר עניין ראשון", end_anchor: END_OF_ARTIFACT }).refusal).toBe("SELECTION_START_ANCHOR_NOT_UNIQUE");
    expect(selectInstrument({ ...BASE, start_anchor: "הודעה על עניין שני", end_anchor: "צו הרחבה בדבר עניין ראשון" }).refusal).toBe("SELECTION_END_BEFORE_START");
    expect(selectInstrument({ ...BASE, start_anchor: "צו הרחבה בדבר עניין ראשון", end_anchor: "לא קיים" }).refusal).toBe("SELECTION_END_ANCHOR_NOT_FOUND");
  });

  it("refuses an anchor too short to be a title", () => {
    expect(selectInstrument({ ...BASE, start_anchor: "רשומות", end_anchor: END_OF_ARTIFACT }).refusal).toBe("SELECTION_ANCHOR_TOO_SHORT");
  });

  it("is deterministic and refuses a span whose bytes moved", () => {
    const first = selectInstrument({ ...BASE, start_anchor: "צו הרחבה בדבר עניין ראשון", end_anchor: "הודעה על עניין שני" }).selection!;
    const again = selectInstrument({ ...BASE, start_anchor: "צו הרחבה בדבר עניין ראשון", end_anchor: "הודעה על עניין שני" }).selection!;
    expect(again.selection_sha256).toBe(first.selection_sha256);
    const moved = [PAGES[0], PAGES[1], { page: 3, text: `${PAGES[2].text} ` }];
    expect(() => selectedPages(first, moved)).toThrow("SELECTION_SHA256_MISMATCH");
  });
});
