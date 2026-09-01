import { describe, expect, it } from "vitest";

import {
  inspectExplicitDynamicTarget,
  runSafeCommand,
  SafeCommandFailure,
  SecretValue,
} from "./index.mts";

describe("V0.9.1 safe process and target contracts", () => {
  it("keeps the inspected environment key as a stable one-item tuple at runtime", () => {
    const inspection = inspectExplicitDynamicTarget({});

    expect(inspection.receipt.inspected_environment_keys).toEqual(["TIVDOC_DYNAMIC_POSTGRES_URL"]);
    expect(Object.isFrozen(inspection.receipt.inspected_environment_keys)).toBe(true);
  });

  it("runs a hermetic child and redacts stdin from both output streams", async () => {
    const secret = new SecretValue("process-contract-secret");
    const script = [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(`out:${input.trim()}:${process.env.NODE_ENV}`);",
      "  process.stderr.write(`err:${encodeURIComponent(input.trim())}`);",
      "});",
    ].join("\n");

    const result = await runSafeCommand({
      executable: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      env: { NODE_ENV: "test" },
      stdin: secret,
      timeout_ms: 10_000,
    });

    expect(result).toMatchObject({ exit_code: 0, signal: null, credentials_emitted: 0 });
    expect(result.stdout).toBe("out:[REDACTED]:test");
    expect(result.stderr).toBe("err:[REDACTED]");
  });

  it("maps a non-zero child exit to a credential-free SafeCommandFailure", async () => {
    const secret = new SecretValue("failure-contract-secret");
    let failure;
    try {
      await runSafeCommand({
        executable: process.execPath,
        args: ["-e", "process.stderr.write(process.env.FAILURE_SECRET ?? ''); process.exit(7);"],
        cwd: process.cwd(),
        env: { FAILURE_SECRET: secret.reveal() },
        redactions: [secret],
        timeout_ms: 10_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SafeCommandFailure);
    expect(failure).toMatchObject({
      name: "SafeCommandFailure",
      result: {
        exit_code: 7,
        stderr: "[REDACTED]",
        credentials_emitted: 0,
      },
    });
  });
});
