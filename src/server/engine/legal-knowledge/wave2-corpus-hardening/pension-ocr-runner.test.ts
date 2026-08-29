import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyPensionSourcePdf } from "./pension-ocr-runner.ts";

describe("Pension OCR runner input boundary", () => {
  it("rejects any unpinned source bytes before a renderer or OCR process can run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tivdoc-a2-pension-source-"));
    const file = path.join(root, "official.pdf");
    await writeFile(file, "%PDF-1.4\nsynthetic\n");
    await expect(verifyPensionSourcePdf(file)).rejects.toThrow("pension_source_pdf_pin_mismatch");
  });

  it("rejects prohibited customer-like paths", async () => {
    await expect(verifyPensionSourcePdf("C:/synthetic/customer-payslip.pdf")).rejects.toThrow("prohibited_customer_path");
  });
});
