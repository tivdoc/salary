// L8-1 / D2. The one rule that says what a script entry point is, shared by
// the static test (every entry point imports the refusal first) and the
// closure proof (every entry point, spawned under a production environment,
// refuses). A rule in two places would drift; this one is imported by both.
//
// An entry point is a file under scripts/ that package.json names as a
// script target, or that runs itself at module top level (`await main()`,
// `main()`, `run()`, or Python's `__main__` block). Test files are not entry
// points. Python files are entry points too — they cannot import the ESM
// guard, so they carry the same check inline, and the closure proof spawns
// them with the interpreter the repository already uses.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAIN_LIKE = /^(?:await main\(|main\(\)|void main\(|main\(\)\.|await run\(|run\(\)|await runCli\(|if __name__ == "__main__")/mu;

export function listScriptEntryPoints(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const targets = new Set();
  for (const command of Object.values(pkg.scripts ?? {})) {
    for (const match of String(command).match(/scripts\/[^\s"]+\.(?:m[jt]s|py)/gu) ?? []) targets.add(match);
  }
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) { if (name !== "__pycache__" && name !== "node_modules") walk(full); }
      else if (/\.(?:mts|mjs|py)$/u.test(name)) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, "scripts"));
  const mains = files.filter((file) => MAIN_LIKE.test(readFileSync(path.join(root, file), "utf8")));
  return [...new Set([...targets, ...mains])]
    .filter((file) => !/\.test\.m[jt]s$/u.test(file))
    .filter((file) => file !== "scripts/production-refusal.mjs")
    .sort();
}

export const PRODUCTION_REFUSAL_CODE = "PRODUCTION_ENVIRONMENT_REFUSED";

/** The guard, as the file must carry it: the first import of an ESM entry point, or the first statement of a Python one. */
export function guardPosition(root, file) {
  const source = readFileSync(path.join(root, file), "utf8");
  const lines = source.split(/\r?\n/u);
  if (file.endsWith(".py")) {
    const first = lines.findIndex((line) => /^(?:import|from)\b/u.test(line) && !line.startsWith("from __future__"));
    const guard = lines.findIndex((line) => line.startsWith("import os as _tivdoc_os, sys as _tivdoc_sys"));
    const refuses = source.includes(`_tivdoc_sys.stderr.write("${PRODUCTION_REFUSAL_CODE}\\n")`) && source.includes("_tivdoc_sys.exit(2)");
    return { guard, first, first_is_guard: guard >= 0 && guard === first && refuses };
  }
  const first = lines.findIndex((line) => /^import\b/u.test(line));
  const guard = lines.findIndex((line) => /^import\s+"[^"]*production-refusal\.mjs";\s*$/u.test(line));
  return { guard, first, first_is_guard: guard >= 0 && guard === first };
}
