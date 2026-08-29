import { describe, expect, it } from "vitest";
import { loadLegalSourceRelations } from "./relations.ts";

describe("explicit source-set relations", () => {
  it("keeps all relations candidate-only and disables automatic legal inference", async () => {
    const manifest = await loadLegalSourceRelations();
    expect(manifest.automatic_legal_inference).toBe(false);
    expect(manifest.relations.every((relation) => relation.review_status === "candidate")).toBe(true);
    expect(manifest.relations.map((relation) => relation.relation_type)).toEqual(["supplements", "supplements"]);
  });
});
