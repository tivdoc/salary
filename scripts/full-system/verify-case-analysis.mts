#!/usr/bin/env node
import "../production-refusal.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
const acceptance = await vite.ssrLoadModule("/src/server/engine/case-analysis/acceptance.ts") as {
  runFullSystemAcceptanceMatrix(): Promise<Record<string, unknown>>;
};
const canonical = await vite.ssrLoadModule("/src/engine/rule-runtime/canonical.ts") as {
  canonicalStringify(value: unknown): string;
};
const report = await acceptance.runFullSystemAcceptanceMatrix();
const rendered = `${canonical.canonicalStringify(report)}\n`;
if (output) {
  const target = path.resolve(output);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, rendered, "utf8");
}
process.stdout.write(`${JSON.stringify({
  schema_version: report.schema_version,
  case_count: report.case_count,
  passed_count: report.passed_count,
  failed_case_ids: report.failed_case_ids,
  report_sha256: report.report_sha256,
  passed: report.passed,
}, null, 2)}\n`);
process.exitCode = report.passed ? 0 : 7;
await vite.close();
