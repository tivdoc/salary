import { expect, it, vi } from "vitest";
import { transferDocuments } from "./document-transfer";
import type { DocumentUpload } from "@/lib/document-upload";

it("retry after a partial transfer reuses the batch, skips stored files, and commits only after all transfers", async () => {
  const manifest: DocumentUpload = { caseId: "case", batchId: "batch", files: [] };
  const files = new Map([["first", new File(["one"], "one.pdf")], ["second", new File(["two"], "two.pdf")]]);
  let firstStored = false;
  let failSecond = true;
  const calls: string[] = [];
  const post = vi.fn(async (route: string) => {
    calls.push(route);
    return route.endsWith("sign") ? { completed: false, uploads: [
      { clientId: "first", uploaded: firstStored, signedUrl: "https://synthetic.invalid/first" },
      { clientId: "second", uploaded: false, signedUrl: "https://synthetic.invalid/second" },
    ] } : { documents: ["first", "second"] };
  });
  const put = vi.fn(async (_url: string, _file: File, id: string) => {
    if (id === "first") firstStored = true;
    if (id === "second" && failSecond) throw new Error("network lost");
  });
  const input = { manifest, files, post, put, signal: new AbortController().signal };
  await expect(transferDocuments(input)).rejects.toThrow("network lost");
  expect(calls).toEqual(["/api/documents/sign"]);
  failSecond = false;
  await expect(transferDocuments(input)).resolves.toEqual({ documents: ["first", "second"] });
  expect(put.mock.calls.map((call) => call[2])).toEqual(["first", "second", "second"]);
  expect(post.mock.calls.filter((call) => call[0].endsWith("sign"))).toHaveLength(2);
  expect(post).toHaveBeenLastCalledWith("/api/documents/complete", { caseId: "case", batchId: "batch" }, input.signal);
});

it("already committed batches do not transfer any file again", async () => {
  const put = vi.fn();
  const post = vi.fn().mockResolvedValueOnce({ completed: true, uploads: [] }).mockResolvedValueOnce({ documents: ["saved"] });
  await transferDocuments({ manifest: { caseId: "case", batchId: "batch", files: [] }, files: new Map(), post, put, signal: new AbortController().signal });
  expect(put).not.toHaveBeenCalled();
});
