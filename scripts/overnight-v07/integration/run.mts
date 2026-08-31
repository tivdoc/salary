import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const output = resolve(process.cwd(), "output/overnight-v0.7/p8/ready-receipt.json");
const vitest = resolve(process.cwd(), "node_modules/vitest/vitest.mjs");
const run = spawnSync(process.execPath, [vitest, "run", "src/server/product/integration/ready-integration.test.ts", "--reporter=dot"], {
  cwd: process.cwd(),
  env: { ...process.env, P8_RECEIPT_OUTPUT: output },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (run.status !== 0) {
  process.stderr.write(run.stdout ?? "");
  process.stderr.write(run.stderr ?? "");
  process.exit(run.status ?? 1);
}
const receipt = JSON.parse(await readFile(output, "utf8")) as Readonly<{
  schema_version: string;
  overall_status: string;
  receipt_sha256: string;
  counts: Readonly<Record<string, number>>;
}>;
  if (receipt.schema_version !== "tivdoc-overnight-v0.7-p8-integrated-v2" || receipt.overall_status !== "INTEGRATED_PASS_WITH_DECLARED_SKIPS" || !/^[a-f0-9]{64}$/.test(receipt.receipt_sha256) || receipt.counts.failed !== 0 || receipt.counts.prohibited_actions !== 0) {
  throw new Error("P8_GENERATED_RECEIPT_INVALID");
}
process.stdout.write(`${JSON.stringify({ status: receipt.overall_status, receipt_sha256: receipt.receipt_sha256, passed: receipt.counts.passed, skipped_blocked: receipt.counts.skipped_blocked, failed: receipt.counts.failed, output })}\n`);
