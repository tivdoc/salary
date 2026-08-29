import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import sharp from "sharp";
import { chooseDeskewAngle, preprocessPayslipDocument } from "./preprocessing";

async function lowResolutionPayslip() {
  return new Uint8Array(await sharp({
    create: { width: 600, height: 800, channels: 3, background: "white" },
  })
    .composite([
      { input: Buffer.from('<svg width="500" height="80"><text x="10" y="50" font-size="30">PAYSLIP 08/2026</text></svg>'), left: 50, top: 50 },
      { input: Buffer.from('<svg width="500" height="300"><rect width="500" height="300" fill="none" stroke="black"/><text x="10" y="50" font-size="24">gross 8500 net 7200</text></svg>'), left: 50, top: 260 },
    ])
    .png()
    .toBuffer());
}

describe("deterministic payslip preprocessing", () => {
  it("preserves the original and produces reproducible 3x grayscale crops", async () => {
    const bytes = await lowResolutionPayslip();
    const first = await preprocessPayslipDocument({ bytes, mime_type: "image/png" });
    const second = await preprocessPayslipDocument({ bytes, mime_type: "image/png" });

    expect(first.original.bytes).toEqual(bytes);
    expect(first.metadata).toMatchObject({
      applied: true,
      source_width: 600,
      source_height: 800,
      upscale_factor: 3,
      grayscale: true,
      reason: "low_resolution_raster",
    });
    expect(first.processed_full_page).toMatchObject({ width: 1_800 });
    expect(first.crops.map((crop) => crop.region)).toEqual(["header", "earnings", "totals", "pension"]);
    expect(first.processed_full_page?.sha256).toBe(second.processed_full_page?.sha256);
    expect(first.crops.map((crop) => crop.image.sha256)).toEqual(second.crops.map((crop) => crop.image.sha256));
  });

  it("limits targeted crops and leaves unsupported PDF bytes untouched", async () => {
    const bytes = await lowResolutionPayslip();
    const targeted = await preprocessPayslipDocument({ bytes, mime_type: "image/png", regions: ["pension"] });
    expect(targeted.crops.map((crop) => crop.region)).toEqual(["pension"]);

    const pdf = new Uint8Array([37, 80, 68, 70]);
    const unsupported = await preprocessPayslipDocument({ bytes: pdf, mime_type: "application/pdf" });
    expect(unsupported.processed_full_page).toBeNull();
    expect(unsupported.crops).toEqual([]);
    expect(unsupported.original.bytes).toEqual(pdf);
  });

  it("applies a small deskew correction only when projection improvement is material", () => {
    expect(chooseDeskewAngle([
      { angle: 0, score: 100 },
      { angle: 1, score: 110 },
    ])).toBe(-1);
    expect(chooseDeskewAngle([
      { angle: 0, score: 100 },
      { angle: 0.25, score: 102 },
    ])).toBe(0);
  });
});
