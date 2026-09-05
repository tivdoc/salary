import "./production-refusal.mjs";
import { readFile, readdir, stat, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const outputPath = path.join(repoRoot, "output", "parallel-wave-1", "scope-scan.json");

const roots = [
  "scripts/legal-acquisition.mts",
  "scripts/legal-sources.mts",
  "scripts/wave1-integrate-evidence.mts",
  "scripts/wave1-pension-convalescence.mts",
  "scripts/wave1-working-time-permits.mts",
  "scripts/wave1-topic-readiness.mts",
  "scripts/wave1-persistence-static.mts",
  "src/engine/wave1",
  "src/engine/legal-knowledge/wave1-review-governance.ts",
  "src/engine/legal-knowledge/wave1-temporal-governance.ts",
  "src/engine/legal-knowledge/wave1-topic-readiness.ts",
  "src/engine/rule-runtime",
  "src/server/engine/legal-knowledge/controlled-import-security.ts",
  "src/server/engine/legal-knowledge/wave1-pension-convalescence.ts",
  "src/server/engine/legal-knowledge/wave1-working-time-permits.ts",
  "src/server/engine/persistence-verification",
] as const;

const exclusions = [
  "documentation",
  "*.test.ts",
  "synthetic fixtures",
  "generated/ignored evidence",
  "scope-scanner pattern declarations (this scanner and the V0.2 acquisition scanner)",
] as const;

const patterns = [
  { name: "OpenAI SDK import/client", expression: /(?:from\s+["']openai["']|new\s+OpenAI\b)/u },
  { name: "Supabase client construction/external connection", expression: /(?:from\s+["']@supabase\/supabase-js["']|\bcreateClient\s*\()/u },
  { name: "customer evaluation or customer pipeline import", expression: /(?:customer-eval|customer-payslip|\/cases\/|\/documents\/)/iu },
  { name: "deployment or migration execution", expression: /(?:\bvercel\s+deploy\b|\bsupabase\s+db\s+(?:push|reset)\b|\bnpx\s+supabase\b)/iu },
  { name: "Finding or eligibility side effect", expression: /(?:\bcreateFinding\s*\(|\bcalculateEligibility\s*\(|\bfindingRepository\.)/u },
  { name: "embedded credential material", expression: /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|service_role\s*[:=]\s*["'][^"']+)/u },
] as const;

function excluded(relative: string) {
  const normalized = relative.replaceAll("\\", "/");
  return normalized.endsWith(".test.ts") || normalized.includes("/synthetic-fixtures.ts");
}

async function filesUnder(relative: string): Promise<string[]> {
  const absolute = path.join(repoRoot, relative);
  const info = await stat(absolute);
  if (info.isFile()) return [relative.replaceAll("\\", "/")];
  const files: string[] = [];
  async function visit(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const target = path.join(directory, name);
      const targetInfo = await stat(target);
      if (targetInfo.isDirectory()) await visit(target);
      else if (targetInfo.isFile()) files.push(path.relative(repoRoot, target).replaceAll("\\", "/"));
    }
  }
  await visit(absolute);
  return files;
}

const allFiles = (await Promise.all(roots.map(filesUnder))).flat().filter((file) => !excluded(file)).sort();
const findings: Array<{ path: string; line: number; pattern: string; excerpt: string }> = [];
for (const relative of allFiles) {
  const lines = (await readFile(path.join(repoRoot, relative), "utf8")).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (
      relative === "scripts/legal-acquisition.mts" &&
      (line.includes("const forbidden") || line.includes('line.includes("customer-eval|cases")'))
    ) continue;
    for (const pattern of patterns) {
      pattern.expression.lastIndex = 0;
      if (pattern.expression.test(line)) {
        findings.push({ path: relative, line: index + 1, pattern: pattern.name, excerpt: line.trim().slice(0, 180) });
      }
    }
  }
}

const report = {
  schema_version: "parallel-wave1-scope-scan-v0.3.1",
  command: "npm run parallel:wave1:scope-scan",
  paths: roots,
  patterns: patterns.map((item) => item.name),
  exclusions,
  scanned_files: allFiles.length,
  findings_count: findings.length,
  findings,
};
await mkdir(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await rm(outputPath, { force: true });
await rename(temporary, outputPath);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = findings.length === 0 ? 0 : 1;
