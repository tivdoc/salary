import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { sha256Schema } from "../../../../engine/legal-knowledge/contracts.ts";

export const controlledImportStages = [
  "received",
  "quarantined",
  "validated",
  "published",
  "ledger_appended",
  "rejected",
] as const;

export type ControlledImportStage = (typeof controlledImportStages)[number];

export const controlledImportJournalBindingSchema = z.object({
  operation_id: z.string().regex(/^[a-f0-9]{64}$/u),
  request_sha256: sha256Schema,
  acquisition_request_id: z.string().min(3),
  source_id: z.string().min(3),
  expected_filename: z.string().min(1),
  expected_media_type: z.literal("application/pdf"),
  expected_artifact_sha256: sha256Schema.nullable(),
  receipt_input_sha256: sha256Schema,
}).strict();

export type ControlledImportJournalBinding = z.infer<typeof controlledImportJournalBindingSchema>;

export const controlledImportJournalEntrySchema = z.object({
  schema_version: z.literal("tivdoc-controlled-import-journal-v0.4"),
  sequence: z.number().int().positive(),
  stage: z.enum(controlledImportStages),
  binding: controlledImportJournalBindingSchema,
  private_artifact_sha256: sha256Schema.nullable(),
  receipt_sha256: sha256Schema.nullable(),
  published_artifact_sha256: sha256Schema.nullable(),
  ledger_record_sha256: sha256Schema.nullable(),
  safe_error_code: z.string().regex(/^[a-z0-9_]+$/u).nullable(),
}).strict();

export type ControlledImportJournalEntry = z.infer<typeof controlledImportJournalEntrySchema>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function controlledImportStableJson(value: unknown) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function controlledImportSha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createControlledImportJournalBinding(input: Readonly<{
  request: unknown;
  acquisitionRequestId: string;
  sourceId: string;
  expectedFilename: string;
  expectedMediaType: "application/pdf";
  expectedArtifactSha256: string | null;
  receiptInputSha256: string;
}>) {
  const requestSha256 = controlledImportSha256(controlledImportStableJson(input.request));
  const operationId = controlledImportSha256(controlledImportStableJson({
    acquisition_request_id: input.acquisitionRequestId,
    source_id: input.sourceId,
    request_sha256: requestSha256,
    expected_filename: input.expectedFilename,
    expected_media_type: input.expectedMediaType,
    expected_artifact_sha256: input.expectedArtifactSha256,
    receipt_input_sha256: input.receiptInputSha256,
  }));
  return controlledImportJournalBindingSchema.parse({
    operation_id: operationId,
    request_sha256: requestSha256,
    acquisition_request_id: input.acquisitionRequestId,
    source_id: input.sourceId,
    expected_filename: input.expectedFilename,
    expected_media_type: input.expectedMediaType,
    expected_artifact_sha256: input.expectedArtifactSha256,
    receipt_input_sha256: input.receiptInputSha256,
  });
}

export async function findRecoverableControlledImportBinding(input: Readonly<{
  ledgerRoot: string;
  requestSha256: string;
  acquisitionRequestId: string;
  sourceId: string;
}>) {
  let operationIds: string[];
  try {
    operationIds = (await readdir(path.join(input.ledgerRoot, ".journals"))).filter((name) => /^[a-f0-9]{64}$/u.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const matches: ControlledImportJournalBinding[] = [];
  for (const operationId of operationIds) {
    const entries = await readControlledImportJournal(input.ledgerRoot, operationId);
    const first = entries[0];
    const last = entries.at(-1);
    if (!first || last?.stage === "rejected" || last?.stage === "ledger_appended") continue;
    if (first.binding.request_sha256 === input.requestSha256
      && first.binding.acquisition_request_id === input.acquisitionRequestId
      && first.binding.source_id === input.sourceId) matches.push(first.binding);
  }
  if (matches.length > 1) throw new Error("controlled_import_recovery_operation_ambiguous");
  return matches[0] ?? null;
}

function ensureChild(rootValue: string, candidateValue: string) {
  const root = path.resolve(rootValue);
  const candidate = path.resolve(candidateValue);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("controlled_import_recovery_path_escape");
  return candidate;
}

async function writeAtomicExact(filePath: string, value: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.pending-${randomUUID()}`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(filePath, "utf8") !== value) throw new Error("controlled_import_journal_immutable_mismatch");
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function expectedNextStage(entries: readonly ControlledImportJournalEntry[], requested: ControlledImportStage) {
  if (entries.length === 0) return requested === "received";
  const previous = entries.at(-1)?.stage;
  if (previous === "rejected" || previous === "ledger_appended") return false;
  if (requested === "rejected") return true;
  const normal: readonly ControlledImportStage[] = ["received", "quarantined", "validated", "published", "ledger_appended"];
  return normal.indexOf(requested) === normal.indexOf(previous as ControlledImportStage) + 1;
}

export async function readControlledImportJournal(ledgerRoot: string, operationId: string) {
  if (!/^[a-f0-9]{64}$/u.test(operationId)) throw new Error("controlled_import_operation_id_invalid");
  const journalRoot = ensureChild(ledgerRoot, path.join(ledgerRoot, ".journals", operationId));
  let names: string[];
  try {
    names = (await readdir(journalRoot)).filter((name) => /^\d{4}-[a-z_]+\.json$/u.test(name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: ControlledImportJournalEntry[] = [];
  for (const [index, name] of names.entries()) {
    const target = ensureChild(journalRoot, path.join(journalRoot, name));
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("controlled_import_journal_file_invalid");
    const entry = controlledImportJournalEntrySchema.parse(JSON.parse(await readFile(target, "utf8")));
    if (entry.sequence !== index + 1 || !name.startsWith(`${String(entry.sequence).padStart(4, "0")}-${entry.stage}.`)) {
      throw new Error("controlled_import_journal_sequence_invalid");
    }
    if (entries.length > 0 && controlledImportStableJson(entries[0].binding) !== controlledImportStableJson(entry.binding)) {
      throw new Error("controlled_import_journal_binding_mismatch");
    }
    entries.push(entry);
  }
  return entries;
}

export async function advanceControlledImportJournal(input: Readonly<{
  ledgerRoot: string;
  binding: ControlledImportJournalBinding;
  stage: ControlledImportStage;
  privateArtifactSha256?: string | null;
  receiptSha256?: string | null;
  publishedArtifactSha256?: string | null;
  ledgerRecordSha256?: string | null;
  safeErrorCode?: string | null;
}>) {
  const binding = controlledImportJournalBindingSchema.parse(input.binding);
  const entries = await readControlledImportJournal(input.ledgerRoot, binding.operation_id);
  if (entries.length > 0 && controlledImportStableJson(entries[0].binding) !== controlledImportStableJson(binding)) {
    throw new Error("controlled_import_journal_binding_mismatch");
  }
  const existing = entries.find((entry) => entry.stage === input.stage);
  const candidate = controlledImportJournalEntrySchema.parse({
    schema_version: "tivdoc-controlled-import-journal-v0.4",
    sequence: existing?.sequence ?? entries.length + 1,
    stage: input.stage,
    binding,
    private_artifact_sha256: input.privateArtifactSha256 ?? null,
    receipt_sha256: input.receiptSha256 ?? null,
    published_artifact_sha256: input.publishedArtifactSha256 ?? null,
    ledger_record_sha256: input.ledgerRecordSha256 ?? null,
    safe_error_code: input.safeErrorCode ?? null,
  });
  if (existing) {
    if (controlledImportStableJson(existing) !== controlledImportStableJson(candidate)) throw new Error("controlled_import_journal_replay_mismatch");
    return existing;
  }
  if (!expectedNextStage(entries, input.stage)) throw new Error("controlled_import_journal_transition_invalid");
  const target = ensureChild(input.ledgerRoot, path.join(input.ledgerRoot, ".journals", binding.operation_id, `${String(candidate.sequence).padStart(4, "0")}-${candidate.stage}.json`));
  await writeAtomicExact(target, controlledImportStableJson(candidate));
  return candidate;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function withControlledImportLock<T>(input: Readonly<{
  ledgerRoot: string;
  acquisitionRequestId: string;
  sourceId: string;
  timeoutMs?: number;
}>, action: () => Promise<T>) {
  const lockKey = controlledImportSha256(controlledImportStableJson({
    acquisition_request_id: input.acquisitionRequestId,
    source_id: input.sourceId,
  }));
  const lockRoot = ensureChild(input.ledgerRoot, path.join(input.ledgerRoot, ".locks"));
  const lockPath = ensureChild(lockRoot, path.join(lockRoot, `${lockKey}.lock`));
  await mkdir(lockRoot, { recursive: true });
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(path.join(lockPath, "owner.json"), controlledImportStableJson({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
        stale = typeof owner.pid !== "number" || !processAlive(owner.pid);
      } catch (ownerError) {
        if ((ownerError as NodeJS.ErrnoException).code !== "ENOENT") throw ownerError;
        try {
          const lockInfo = await stat(lockPath);
          stale = Date.now() - lockInfo.mtimeMs > 1_000;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
      }
      if (stale) {
        const stalePath = ensureChild(lockRoot, path.join(lockRoot, `${lockKey}.stale-${randomUUID()}`));
        try {
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
        } catch (takeoverError) {
          if ((takeoverError as NodeJS.ErrnoException).code !== "ENOENT") throw takeoverError;
        }
        continue;
      }
      if (Date.now() - started >= (input.timeoutMs ?? 5_000)) throw new Error("controlled_import_concurrency_lock_timeout");
      await delay(10);
    }
  }
  try {
    return await action();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { token?: unknown };
      if (owner.token === token) await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
