// Wave 6 (K-4). The parser isolation contract, applied to the parsers this
// run actually used, with the fail-closed detector's verdict on this host and
// the exact environment that would close it.
//
// What is true today, stated plainly: the sixty-nine observation parses of
// Pool E ran pypdf and, for seven scans, Tesseract, as ordinary child
// processes of the parse runner (observation-parse-runner.mts, execFileSync)
// — a process boundary and nothing more. No kernel boundary, no network
// denial, no read-only rootfs, no hard resource limit, and an inherited
// environment. The inputs were public legal documents fetched under the
// owner's acquisition record, not customer data, which is why that was
// acceptable for a parse whose output is `derived` and cites nothing by byte.
// It is not acceptable for a customer document, and the detector says so:
// PARSER_OS_SANDBOX_NOT_VERIFIED, the parser not runnable for owner import.
//
// The toolchain pins below are observed on this host — interpreter, package
// versions, OCR binary and model data, each with its digest where the file is
// addressable — so the closing environment can be procured against real
// digests rather than names.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  detectLocalParserSandboxPlatform,
  localParserSandboxCapability,
  parserIsolationClosingEnvironment,
  parserSandboxSpecification,
  type ParserIsolationPinnedTool,
} from "../../src/server/platform/security/parser-sandbox.ts";
import { parserIsolationAssurance } from "../../src/server/engine/legal-knowledge/parser-isolation/index.ts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const RECEIPT_ROOT = path.join("output", WAVE, "audit");
const VENV_PYTHON = path.join("output", "pdf-venv", "Scripts", "python.exe");
const TESSERACT = "C:\\Program Files\\Tesseract-OCR\\tesseract.exe";
const TRAINEDDATA = path.join(process.env.LOCALAPPDATA ?? "", "Temp", "tivdoc-a2-tessdata", "heb.traineddata");

function digestOf(file: string): Readonly<{ sha256: string | null; byte_count: number | null }> {
  if (!existsSync(file)) return { sha256: null, byte_count: null };
  return { sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), byte_count: statSync(file).size };
}

function versionOf(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], { encoding: "utf8", timeout: 20_000, windowsHide: true }).split(/\r?\n/u)[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

function pythonPackages(): ReadonlyMap<string, string> {
  try {
    const raw = execFileSync(VENV_PYTHON, ["-m", "pip", "list", "--format=json"], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    return new Map((JSON.parse(raw) as readonly { name: string; version: string }[]).map((entry) => [entry.name.toLowerCase(), entry.version]));
  } catch {
    return new Map();
  }
}

function observedToolchain(): readonly ParserIsolationPinnedTool[] {
  const packages = pythonPackages();
  const python = digestOf(VENV_PYTHON);
  const tesseract = digestOf(TESSERACT);
  const model = digestOf(TRAINEDDATA);
  const pin = (tool: string, version: string | null, digest: ReturnType<typeof digestOf>, locator_class: ParserIsolationPinnedTool["locator_class"]): ParserIsolationPinnedTool =>
    Object.freeze({ tool, version: version ?? "unobserved", ...digest, locator_class, observed_on_host: version !== null || digest.sha256 !== null });
  return Object.freeze([
    pin("python", versionOf(VENV_PYTHON, ["--version"])?.replace(/^Python /u, "") ?? null, python, "interpreter"),
    pin("pypdf", packages.get("pypdf") ?? null, { sha256: null, byte_count: null }, "python_package"),
    pin("pymupdf", packages.get("pymupdf") ?? null, { sha256: null, byte_count: null }, "python_package"),
    pin("tesseract", versionOf(TESSERACT, ["--version"])?.replace(/^tesseract /u, "") ?? null, tesseract, "native_binary"),
    pin("heb.traineddata", model.sha256 ? "tessdata_best or tessdata as fetched for A-2" : null, model, "model_data"),
  ]);
}

function main(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const detection = detectLocalParserSandboxPlatform();
  const capability = localParserSandboxCapability(detection);
  const toolchain = observedToolchain();
  const closing = parserIsolationClosingEnvironment(toolchain);

  const receipt = {
    schema_version: "tivdoc-parser-isolation-contract-wave6",
    observed_at: new Date().toISOString(),
    verdict: {
      blocker_code: capability.blocker_code,
      blocker_reason: capability.blocker_reason,
      runnable_for_owner_import: capability.runnable,
      os_kernel_boundary_verified: detection.os_kernel_boundary_verified,
      network_kernel_denial: detection.node_permission_model.network_kernel_denial,
      locally_detected_primitives: detection.locally_detected_primitives,
      selected_profile: detection.selected_profile,
      claim: "no OS sandbox primitive is claimed; presence of a binary is not a boundary",
    },
    how_pool_e_actually_ran: {
      runner: "scripts/legal-review-projection/observation-parse-runner.mts",
      launch: "execFileSync(VENV_PYTHON, [script, file]) at lines 105 and 121: a child process with the inherited environment, no permission model, no allowlist, no kernel boundary, no network denial, a maxBuffer and (OCR only) a wall timeout",
      inputs: "sixty-nine public legal documents under the owner's acquisition record; no customer document",
      outputs: "derived text (`derived`, and `ocr_derived: true` for seven scans); never an exact-byte citation",
      isolation_class: "process_boundary_only",
      acceptable_for: "public-document parses whose output is derived",
      not_acceptable_for: "any customer document, any owner import, any parse whose output is trusted by byte",
    },
    typescript_screener_assurance: parserIsolationAssurance,
    specification: parserSandboxSpecification(),
    closing_environment: closing,
    procurement_summary: [
      "OCI image by digest: pinned Python 3.13 runtime + pypdf 6.16.2 + PyMuPDF 1.26.4 + tesseract 5.4.0 + heb.traineddata, SBOM recorded",
      "kernel isolation: gVisor (runsc) or Kata/Firecracker microVM, or Hyper-V isolated container; attestation recorded per launch",
      "no network: --network none (or no network device), proven by an in-boundary egress probe that must fail on every launch",
      "pinned toolchain: hashes verified inside the boundary against the pin list before every parse",
      "hard limits: cgroup/job-object CPU and RSS, pid limit, wall timeout killing the tree, read-only rootfs, non-root, seccomp profile by digest",
      "receipt binding: input sha256, tool digests, image digest, profile digest and limits hashed into the parse receipt",
    ],
  };
  writeFileSync(path.join(RECEIPT_ROOT, "parser-isolation.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`blocker=${receipt.verdict.blocker_code} runnable=${receipt.verdict.runnable_for_owner_import}`
    + ` primitives=${detection.locally_detected_primitives.join(",") || "none"} pins=${toolchain.filter((t) => t.observed_on_host).length}/${toolchain.length}\n`);
  for (const tool of toolchain) process.stdout.write(`  ${tool.tool} ${tool.version} ${tool.sha256 ? tool.sha256.slice(0, 16) + "…" : "-"} ${tool.observed_on_host ? "observed" : "unobserved"}\n`);
}

main();
