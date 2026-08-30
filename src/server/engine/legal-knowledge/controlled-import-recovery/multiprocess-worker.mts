import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { importControlledOfficialArtifact } from "../controlled-import-security.ts";
import { withControlledImportLock } from "./protocol.ts";

type WorkerInput = Readonly<{
  mode: "import" | "hold_lock";
  import_input?: Parameters<typeof importControlledOfficialArtifact>[0];
  ledger_root?: string;
  acquisition_request_id?: string;
  source_id?: string;
  ready_path?: string;
}>;

const inputPath = process.argv[2];
if (!inputPath) throw new Error("multiprocess_worker_input_required");
const input = JSON.parse(await readFile(inputPath, "utf8")) as WorkerInput;

if (input.mode === "import" && input.import_input) {
  try {
    const result = await importControlledOfficialArtifact(input.import_input);
    process.stdout.write(`${JSON.stringify({ ok: true, created: result.created, idempotent: result.idempotent })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error instanceof Error ? error.message : "unknown_error" })}\n`);
    process.exitCode = 2;
  }
} else if (input.mode === "hold_lock" && input.ledger_root && input.acquisition_request_id && input.source_id && input.ready_path) {
  await withControlledImportLock({
    ledgerRoot: input.ledger_root,
    acquisitionRequestId: input.acquisition_request_id,
    sourceId: input.source_id,
  }, async () => {
    await writeFile(input.ready_path!, "ready\n", { flag: "wx" });
    await new Promise<void>(() => undefined);
  });
} else {
  throw new Error("multiprocess_worker_input_invalid");
}
