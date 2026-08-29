import { spawnSync } from "node:child_process";
import path from "node:path";
import { normalizeRelative, sha256, WAVE1_ORIGINAL_BASE } from "./common.ts";
import { runRuntimeDenialCanaries } from "./runtime-denial.ts";

const FORBIDDEN_PATTERNS = [
  { id: "openai_client_construction", expression: /(?:from\s+["']openai["']|require\(["']openai["']\)|new\s+OpenAI\s*\()/u },
  { id: "external_supabase_client_construction", expression: /(?:from\s+["']@supabase\/supabase-js["']|createClient\s*\(\s*https?:\/\/)/u },
  { id: "prohibited_customer_path", expression: /(?:customer-payslip-data-only-v3|eval[\\/]customer-payslips|customer-payslips)/iu },
  { id: "migration_execution", expression: /(?:supabase\s+db\s+(?:push|reset)|psql\b[^\n]*migration|executeMigration\s*\()/iu },
  { id: "deployment_execution", expression: /(?:vercel\s+deploy|executeDeploy\s*\()/iu },
  { id: "finding_emission", expression: /(?:emitFinding\s*\(|createFinding\s*\(|findingRepository\s*\.)/u },
] as const;

function git(repoRoot: string, args: readonly string[], allowFailure = false) {
  const result = spawnSync("git", [...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) throw new Error(`full_diff_git_failed:${args.join("_")}`);
  return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function lines(value: string) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

export function classifyChangedPath(relative: string) {
  const normalized = normalizeRelative(relative);
  if (normalized.startsWith("output/") || normalized.startsWith("eval/")) return "generated_or_ignored_evidence";
  if (normalized.endsWith(".md")) return "documentation";
  if (/(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$/u.test(normalized) || normalized.includes("/__tests__/")) return "test";
  if (normalized === "package.json") return "package_manifest";
  if (/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(normalized)) return "lockfile";
  if (/(?:^|\/)(?:next|eslint|vitest|playwright|postcss|tailwind)\.config\.[cm]?[jt]s$/u.test(normalized)
    || normalized === "tsconfig.json"
    || normalized === ".gitignore"
    || /(?:^|\/)execution-contract\.[^/]+\.json$/u.test(normalized)) return "configuration";
  if (normalized.startsWith("scripts/")) return "executable_script";
  return "source";
}

function addedLines(repoRoot: string, range: string, relative: string) {
  const output = git(repoRoot, ["diff", "--unified=0", "--no-ext-diff", range, "--", relative]).stdout;
  return output.split(/\r?\n/u)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

export function scanAddedLine(relative: string, line: string) {
  const category = classifyChangedPath(relative);
  return FORBIDDEN_PATTERNS.flatMap((pattern) => {
    pattern.expression.lastIndex = 0;
    if (!pattern.expression.test(line)) return [];
    const testReferenceAllowed = category === "test"
      && (
        (pattern.id === "prohibited_customer_path" && /(?:expect|toThrow|reject|deni|prohibit|fixture)/iu.test(line))
        || /scanAddedLine\s*\(/u.test(line)
      );
    const documentationOnly = category === "documentation";
    const scannerDeclaration = normalizeRelative(relative).endsWith("full-diff-scan.ts");
    const canaryDeclaration = normalizeRelative(relative).endsWith("runtime-denial.ts")
      && (
        /denyRuntimeAction|PROHIBITED_RUNTIME_ACTIONS/u.test(line)
        || pattern.id === "prohibited_customer_path"
      );
    const contractDeclaration = /(?:^|\/)execution-contract\.[^/]+\.json$/u.test(normalizeRelative(relative));
    const violation = !(documentationOnly || testReferenceAllowed || scannerDeclaration || canaryDeclaration || contractDeclaration);
    return [{
      pattern: pattern.id,
      category,
      disposition: documentationOnly
        ? "documented_reference"
        : testReferenceAllowed
          ? "denial_test_reference"
          : scannerDeclaration
              ? "scanner_pattern_declaration"
              : canaryDeclaration
                ? "runtime_canary_declaration"
                : contractDeclaration
                  ? "forbidden_boundary_contract_declaration"
                : "prohibited_executable_addition",
      violation,
      excerpt_sha256: sha256(line.trim()),
    }];
  });
}

export function scanFullChangedFileRange(input: Readonly<{
  repo_root: string;
  from?: string;
  to?: string;
}>) {
  const repoRoot = path.resolve(input.repo_root);
  const from = input.from ?? WAVE1_ORIGINAL_BASE;
  const to = input.to ?? "HEAD";
  const range = `${from}..${to}`;
  const changedRows = lines(git(repoRoot, ["diff", "--name-status", "--find-renames=100%", range]).stdout);
  const inventory = changedRows.map((row) => {
    const [status, ...names] = row.split("\t");
    const paths = names.map(normalizeRelative);
    return { status, paths };
  });
  const allPaths = [...new Set(inventory.flatMap((entry) => entry.paths))].sort();
  const files = allPaths.map((relative) => {
    const object = git(repoRoot, ["show", `${to}:${relative}`], true);
    const contentAvailable = object.status === 0;
    const additions = addedLines(repoRoot, range, relative);
    const matches = additions.flatMap((line) => scanAddedLine(relative, line));
    return {
      path: relative,
      category: classifyChangedPath(relative),
      status: inventory.find((entry) => entry.paths.includes(relative))?.status ?? "unknown",
      content_available_at_target: contentAvailable,
      target_content_sha256: contentAvailable ? sha256(object.stdout) : null,
      added_line_count: additions.length,
      pattern_matches: matches,
    };
  });
  const violations = files.flatMap((file) => file.pattern_matches
    .filter((match) => match.violation)
    .map((match) => ({ path: file.path, ...match })));
  const canaries = runRuntimeDenialCanaries();
  return {
    schema_version: "tivdoc-wave2-full-diff-scope-scan-v0.4",
    range,
    from,
    to,
    changed_path_count: allPaths.length,
    classifications: Object.fromEntries(
      [...new Set(files.map((file) => file.category))]
        .sort()
        .map((category) => [category, files.filter((file) => file.category === category).length]),
    ),
    every_changed_path_inventoried: files.length === allPaths.length,
    files,
    forbidden_pattern_ids: FORBIDDEN_PATTERNS.map((pattern) => pattern.id),
    violation_count: violations.length,
    violations,
    runtime_denial_canaries: canaries,
    passed: violations.length === 0 && canaries.passed,
    note: "Documentation, tests, package/lock/config and generated-evidence paths remain inventoried; dispositions do not remove them from the report.",
  } as const;
}
