import { spawn } from "node:child_process";
import { basename, isAbsolute } from "node:path";

import type { ApprovedPostgresTarget, SecretValue } from "./safety.mts";

const OUTPUT_LIMIT_BYTES = 1_048_576;

export type SafeCommand = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: SecretValue;
  redactions?: readonly SecretValue[];
  timeout_ms?: number;
}>;

export type SafeCommandResult = Readonly<{
  executable_name: string;
  exit_code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  credentials_emitted: 0;
}>;

export type CommandRunner = (command: SafeCommand) => Promise<SafeCommandResult>;

export class SafeCommandFailure extends Error {
  readonly result: SafeCommandResult;

  constructor(result: SafeCommandResult) {
    super(`POSTGRES_COMMAND_FAILED:${result.executable_name}:exit=${result.exit_code}`);
    this.name = "SafeCommandFailure";
    this.result = result;
  }
}

export const runSafeCommand: CommandRunner = async (command) => {
  validateCommand(command);
  const started = Date.now();
  const redactions = [command.stdin, ...(command.redactions ?? [])]
    .filter((value): value is SecretValue => value !== undefined)
    .map((value) => value.reveal());

  return await new Promise<SafeCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env ? childProcessEnvironment(command.env) : minimalChildEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, command.timeout_ms ?? 30_000);

    const append = (kind: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > OUTPUT_LIMIT_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      if (kind === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new Error(`POSTGRES_COMMAND_SPAWN_FAILED:${basename(command.executable)}:${error.name}`));
    });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result: SafeCommandResult = Object.freeze({
        executable_name: basename(command.executable),
        exit_code: code ?? (timedOut ? 124 : 1),
        signal,
        stdout: redact(stdout, redactions),
        stderr: redact(
          `${stderr}${timedOut ? "\nCOMMAND_TIMEOUT" : ""}${outputBytes > OUTPUT_LIMIT_BYTES ? "\nOUTPUT_LIMIT_EXCEEDED" : ""}`,
          redactions,
        ),
        duration_ms: Date.now() - started,
        credentials_emitted: 0,
      });
      if (result.exit_code === 0 && !timedOut && outputBytes <= OUTPUT_LIMIT_BYTES) resolvePromise(result);
      else rejectPromise(new SafeCommandFailure(result));
    };
    // On Windows pg_ctl can exit successfully while the detached postgres
    // process keeps inherited pipe handles open. `close` then never fires, so
    // settle from the command process' own exit after a short drain window.
    child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), 50));
    child.on("close", finish);
    if (command.stdin) child.stdin.end(`${command.stdin.reveal()}\n`, "utf8");
    else child.stdin.end();
  });
};

export function buildPostgresChildEnvironment(
  target: ApprovedPostgresTarget,
  database = target.descriptor.database,
): Readonly<Record<string, string>> {
  const inherited = minimalChildEnvironment();
  return Object.freeze({
    ...inherited,
    PGHOST: target.descriptor.host,
    PGPORT: String(target.descriptor.port),
    PGDATABASE: database,
    PGUSER: target.username.reveal(),
    PGPASSWORD: target.password.reveal(),
    PGCONNECT_TIMEOUT: "5",
    PGAPPNAME: "tivdoc-dynamic-v0.9.1",
    PGSSLMODE: "disable",
    PGTZ: "UTC",
  });
}

export function redact(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets.filter((item) => item.length > 0).sort((a, b) => b.length - a.length)) {
    safe = safe.replaceAll(secret, "[REDACTED]");
    try {
      safe = safe.replaceAll(encodeURIComponent(secret), "[REDACTED]");
    } catch {
      // The raw form was already handled.
    }
  }
  return safe.replace(/(postgres(?:ql)?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@");
}

function validateCommand(command: SafeCommand): void {
  if (!isAbsolute(command.executable)) throw new Error("POSTGRES_EXECUTABLE_NOT_ABSOLUTE");
  if (command.args.some((argument) => argument.includes("\0"))) throw new Error("POSTGRES_COMMAND_ARGUMENT_INVALID");
  const secrets = [command.stdin, ...(command.redactions ?? [])]
    .filter((value): value is SecretValue => value !== undefined)
    .map((value) => value.reveal());
  if (command.args.some((argument) => secrets.some((secret) => argument.includes(secret)))) {
    throw new Error("POSTGRES_SECRET_IN_COMMAND_ARGUMENT");
  }
}

function minimalChildEnvironment(): NodeJS.ProcessEnv {
  const source = process.env;
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"] as const) {
    const value = source[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function childProcessEnvironment(source: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const requestedNodeEnvironment = source.NODE_ENV;
  const nodeEnvironment = requestedNodeEnvironment === "development"
    || requestedNodeEnvironment === "test"
    || requestedNodeEnvironment === "production"
    ? requestedNodeEnvironment
    : "production";
  const environment: NodeJS.ProcessEnv = { NODE_ENV: nodeEnvironment };
  for (const [name, value] of Object.entries(source)) {
    if (name !== "NODE_ENV") environment[name] = value;
  }
  return environment;
}
