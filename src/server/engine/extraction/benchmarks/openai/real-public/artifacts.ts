import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ImmutableDocument } from "@/engine/domain/documents";
import { extractionRequestSchema } from "@/engine/extraction/contracts";
import type { PrivateDocumentSource } from "@/engine/extraction/provider";
import type { BenchmarkArtifact } from "../benchmark";
import { realPublicPayslipGroundTruth } from "./ground-truth";

const manifestSchema = z.object({
  version: z.literal("1.1"),
  created_at: z.string(),
  fixtures: z.array(z.object({
    fixture_id: z.string().regex(/^REAL_PUBLIC_00[1-5]$/),
    file_name: z.string().regex(/^REAL_PUBLIC_00[1-5]\.png$/),
    format: z.literal("png"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    redaction_regions: z.number().int().positive(),
    pay_period: z.string().regex(/^20\d{2}-(?:0[1-9]|1[0-2])$/),
  }).strict()).length(5),
}).strict();

const caseId = "99999999-9999-4999-8999-999999999999";
const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const timestamp = "2026-08-29T00:00:00.000Z";

function uuid(number: number) {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

export async function loadRealPublicPayslipArtifacts(redactedDirectory: string): Promise<readonly BenchmarkArtifact[]> {
  const manifestPath = path.join(redactedDirectory, "manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const truthById = new Map(realPublicPayslipGroundTruth.map((truth) => [truth.fixture_id, truth]));
  const ids = manifest.fixtures.map((fixture) => fixture.fixture_id).sort();
  const expectedIds = realPublicPayslipGroundTruth.map((truth) => truth.fixture_id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    throw new TypeError("Real-public manifest must contain the five frozen neutral fixture IDs");
  }

  const artifacts: BenchmarkArtifact[] = [];
  for (const [index, fixture] of [...manifest.fixtures].sort((left, right) => left.fixture_id.localeCompare(right.fixture_id)).entries()) {
    const truth = truthById.get(fixture.fixture_id);
    if (!truth) throw new TypeError("Real-public fixture has no frozen ground truth");
    if (fixture.pay_period !== truth.layout.pay_period) throw new TypeError("Redacted fixture period differs from frozen ground truth");
    const filePath = path.resolve(redactedDirectory, fixture.file_name);
    if (path.dirname(filePath) !== path.resolve(redactedDirectory)) throw new TypeError("Real-public fixture path escaped the approved directory");
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== fixture.sha256) throw new TypeError("Redacted real-public fixture checksum mismatch");
    const documentId = uuid(80_000 + index);
    const document: ImmutableDocument = {
      document_id: documentId,
      case_id: caseId,
      document_type: "payslip",
      original_filename: `${fixture.fixture_id}.png`,
      mime_type: "image/png",
      size_bytes: bytes.byteLength,
      content_sha256: sha256,
      storage_path: `cases/${caseId}/documents/${documentId}/original.png`,
      document_period: null,
      supersedes_document_id: null,
      created_at: timestamp,
    };
    const request = extractionRequestSchema.parse({
      case_id: caseId,
      analysis_run_id: runId,
      extraction_id: uuid(81_000 + index),
      document,
      declared_document_type: "payslip",
      requested_at: timestamp,
    });
    artifacts.push({
      fixture_id: fixture.fixture_id,
      quality: truth.layout.quality_issues.join("+"),
      format: "png",
      file_path: filePath,
      sha256,
      request,
    });
  }
  return artifacts;
}

export class RealPublicPayslipDocumentSource implements PrivateDocumentSource {
  private readonly approvedByDocumentId: ReadonlyMap<string, Readonly<{ filePath: string; sha256: string }>>;

  constructor(artifacts: readonly BenchmarkArtifact[]) {
    this.approvedByDocumentId = new Map(artifacts.map((artifact) => [
      artifact.request.document.document_id,
      { filePath: artifact.file_path, sha256: artifact.sha256 },
    ]));
  }

  async read(document: ImmutableDocument) {
    const approved = this.approvedByDocumentId.get(document.document_id);
    if (!approved) throw new TypeError("Document is outside the approved redacted real-public corpus");
    const bytes = await readFile(approved.filePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== approved.sha256 || digest !== document.content_sha256) {
      throw new TypeError("Redacted real-public document checksum mismatch");
    }
    return new Uint8Array(bytes);
  }
}

export async function sha256File(filePath: string) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
