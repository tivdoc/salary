// L9-7. What a test needs from the host, said out loud.
//
// The first CI run on GitHub (d4090e0, run 33954357795) failed sixteen files
// that pass on the machine the project was built on: they read evidence trees
// that are untracked by design (`eval/`, `output/`, sibling worktrees whose
// commits were never pushed), spawn Python through a Windows launcher, pin
// the Windows Git toolchain, or hash the working copy's CRLF bytes. None of
// that is a defect in the code under test; all of it was an unstated
// precondition. A test that needs the host states it here, and skips with
// the reason when it does not hold — on the machine that holds the evidence
// it runs, and the freeze runs it there.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type HostPrecondition = Readonly<{ holds: boolean; reason: string }>;

/** Local artifacts the test verifies: every path must exist. */
export function localArtifacts(paths: readonly string[]): HostPrecondition {
  const missing = paths.filter((candidate) => !existsSync(path.resolve(candidate)));
  return missing.length === 0
    ? { holds: true, reason: "" }
    : { holds: false, reason: `local evidence absent on this host: ${missing.join(", ")}` };
}

/** The Windows host the V0.9.1 trusted-Git foundation pins by design. */
export function windowsHost(): HostPrecondition {
  return process.platform === "win32"
    ? { holds: true, reason: "" }
    : { holds: false, reason: `the trusted-Git foundation pins the Windows toolchain and the working copy's bytes; host is ${process.platform}` };
}

/** A Python 3 the host can run: the bundled runtime, then the launcher, then the plain commands. */
export function resolvePython(): Readonly<{ command: string; prefix: readonly string[] }> | null {
  const bundled = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python", "python.exe")
    : null;
  const candidates: Array<{ command: string; prefix: string[] }> = [
    ...(bundled && existsSync(bundled) ? [{ command: bundled, prefix: [] }] : []),
    { command: "py", prefix: ["-3"] },
    { command: "python3", prefix: [] },
    { command: "python", prefix: [] },
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (probe.status === 0 && /^Python 3\./u.test(`${probe.stdout}${probe.stderr}`.trim())) return candidate;
  }
  return null;
}

export function pythonHost(): HostPrecondition {
  return resolvePython() ? { holds: true, reason: "" } : { holds: false, reason: "no Python 3 on this host" };
}

/** `main` as this checkout knows it: a local branch, or the remote-tracking ref a CI checkout has. */
export function resolveMainRef(): string {
  for (const candidate of ["main", "origin/main"]) {
    const probe = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  throw new Error("MAIN_REF_UNRESOLVED: neither main nor origin/main is present in this checkout");
}
