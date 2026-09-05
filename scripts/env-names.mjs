// Long run 9 / 0.1. Prints only the NAMES of variables defined in an env
// file or the process environment — never a value. Use this to inspect any
// `.env*` file or credential file instead of `cat`/`type`/`Get-Content`,
// which would print secret values.
//
//   node scripts/env-names.mjs <path-to-env-file>
//   node scripts/env-names.mjs --process [PREFIX...]
import { readFileSync } from "node:fs";

const NAME = /^([A-Z_][A-Z0-9_]*)=/u;

function namesFromEnvFile(path) {
  const text = readFileSync(path, "utf8");
  const names = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = NAME.exec(trimmed);
    if (match) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}

function namesFromProcessEnv(prefixes) {
  const names = Object.keys(process.env).filter((name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix)));
  return [...new Set(names)].sort();
}

const args = process.argv.slice(2);
if (args[0] === "--process") {
  const names = namesFromProcessEnv(args.slice(1));
  console.log(JSON.stringify({ source: "process.env", prefixes: args.slice(1), count: names.length, names }, null, 2));
} else if (args[0]) {
  const names = namesFromEnvFile(args[0]);
  console.log(JSON.stringify({ source: args[0], count: names.length, names }, null, 2));
} else {
  console.error("USAGE: node scripts/env-names.mjs <path> | node scripts/env-names.mjs --process [PREFIX...]");
  process.exitCode = 2;
}
