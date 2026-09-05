// Run 13-T / D1 — is production reachable from this machine, by name only.
//
// The product runtime reads `public.cases`, `questionnaire_responses`,
// `documents` and `payments` and the `salary-documents` bucket through
// `getSupabaseAdmin()` (src/lib/supabase-admin.ts), which needs
// NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; extraction (D2)
// needs OPENAI_API_KEY and OPENAI_EXTRACTION_MODEL. This script reports, for
// each variable, whether a value is present in the places a credential may
// legitimately live on this machine — the process environment, the
// repository's .env files, the ~/.tivdoc-* credential stores — and never
// reads, prints or copies a value. Absent means BLOCKED_PRODUCTION_UNREACHABLE,
// as the brief instructs: no guessing, no copying keys from any file.
import "../production-refusal.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const REQUIRED = [
  { name: "NEXT_PUBLIC_SUPABASE_URL", needed_by: "D1 — production project URL (src/lib/supabase-admin.ts)" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", needed_by: "D1 — server-side read of public.* and the salary-documents bucket" },
  { name: "OPENAI_API_KEY", needed_by: "D2 — the configured extraction provider" },
  { name: "OPENAI_EXTRACTION_MODEL", needed_by: "D2 — the model the report must name per call" },
] as const;

function namesInEnvFile(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split(/\r?\n/u)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")).trim())
    .filter((name) => name.length > 0));
}

function main(): void {
  const home = homedir();
  const repoEnvFiles = readdirSync(".").filter((f) => f.startsWith(".env") && f !== ".env.example");
  const storeDirs = readdirSync(home).filter((f) => f.startsWith(".tivdoc")).map((f) => path.join(home, f));
  const storeFiles = storeDirs.flatMap((dir) => readdirSync(dir).map((f) => path.join(dir, f)));
  const places = [
    ...repoEnvFiles.map((f) => ({ place: f, names: namesInEnvFile(f) })),
    ...storeFiles.map((f) => ({ place: f.replace(home, "~"), names: namesInEnvFile(f) })),
  ];
  const vercelDir = existsSync(".vercel");
  const variables = REQUIRED.map((v) => {
    const inProcess = typeof process.env[v.name] === "string" && process.env[v.name]!.length > 0;
    const inFiles = places.filter((p) => p.names.has(v.name)).map((p) => p.place);
    return { ...v, present_in_process_env: inProcess, present_in_files: inFiles, present: inProcess || inFiles.length > 0 };
  });
  const missing = variables.filter((v) => !v.present).map((v) => v.name);
  const receipt = {
    schema_version: "tivdoc-trial-13t-production-reachability-v1",
    unit: "L13T-1",
    checked_at: new Date().toISOString(),
    places_checked: {
      process_env: true,
      repository_env_files: repoEnvFiles,
      credential_stores: storeFiles.map((f) => f.replace(home, "~")),
      vercel_link_directory: vercelDir,
    },
    values_read: false,
    variables,
    missing,
    status: missing.length === 0 ? "REACHABLE_BY_NAME" : "BLOCKED_PRODUCTION_UNREACHABLE",
    blocked_units: missing.length === 0 ? [] : ["L13T-1 (D1)", "L13T-2 (D2)", "L13T-3 (D3)", "L13T-4 (D4)", "L13T-5 (D5)"],
    note: "Presence by name only. A present name would still need the value to be loaded by the runtime's own loader; none is loaded here.",
  };
  mkdirSync(path.join("output", "next", "trial-13t"), { recursive: true });
  const receiptPath = path.join("output", "next", "trial-13t", "production-reachability.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`T13_REACHABILITY ${JSON.stringify({ status: receipt.status, missing, places: receipt.places_checked, receipt: receiptPath })}`);
  if (missing.length > 0) process.exitCode = 3;
}

main();
