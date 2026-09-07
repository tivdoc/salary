import type { DocumentUpload } from "@/lib/document-upload";

export type SignedUpload = { clientId: string; uploaded: boolean; signedUrl?: string };
/** Stable identity survives a lost sign/PUT/commit response. The server owns slots and paths. */
export async function transferDocuments(input: {
  manifest: DocumentUpload;
  files: ReadonlyMap<string, File>;
  signal: AbortSignal;
  put: (url: string, file: File, clientId: string, signal: AbortSignal) => Promise<void>;
  post: (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
}) {
  const signed = await input.post("/api/documents/sign", input.manifest, input.signal) as { completed: boolean; uploads: SignedUpload[] };
  if (!signed.completed) for (const upload of signed.uploads) {
    if (upload.uploaded) continue;
    const file = input.files.get(upload.clientId);
    if (!file || !upload.signedUrl) throw new Error("הקבצים חסרים. יש לבחור אותם שוב.");
    await input.put(upload.signedUrl, file, upload.clientId, input.signal);
  }
  return input.post("/api/documents/complete", { caseId: input.manifest.caseId, batchId: input.manifest.batchId }, input.signal);
}
