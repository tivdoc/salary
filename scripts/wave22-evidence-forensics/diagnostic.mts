import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const bundled = process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
  : "";
const command = bundled && existsSync(bundled) ? bundled : "py";
const prefix = command === "py" ? ["-3"] : [];
const result = spawnSync(command, [
  ...prefix,
  path.resolve("scripts", "wave22-evidence-forensics", "forensics.py"),
  "diagnostic",
  "--repo-root", process.cwd(),
  ...process.argv.slice(2),
], { cwd: process.cwd(), stdio: "inherit", windowsHide: true });
process.exitCode = result.status ?? 2;
