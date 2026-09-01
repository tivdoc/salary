import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildNodePermissionParserLaunchProfile,
  detectLocalParserSandboxPlatform,
  localParserSandboxCapability,
  parserSandboxExpectedEnvironmentKeys,
} from "./parser-sandbox.ts";

describe("MC-10 parser sandbox platform proof", () => {
  it("detects the strongest local primitive but retains the exact kernel blocker", () => {
    const detection = detectLocalParserSandboxPlatform();
    const capability = localParserSandboxCapability(detection);
    expect(detection).toMatchObject({
      schema_version: "tivdoc-parser-sandbox-platform-detection-v0.10.0",
      platform: process.platform,
      node_version: process.versions.node,
      os_kernel_boundary_verified: false,
      blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    });
    expect(detection.node_permission_model.network_kernel_denial).toBe(false);
    expect(capability).toMatchObject({
      runnable: false,
      persistent_owner_import_enabled: false,
      blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    });
  });

  it("builds an explicit Node permission profile with distinct roots and a sanitized environment", () => {
    const root = path.resolve(os.tmpdir(), "synthetic-parser-profile");
    const profile = buildNodePermissionParserLaunchProfile({
      worker_path: path.join(root, "worker.mts"),
      request_path: path.join(root, "control", "request.json"),
      input_path: path.join(root, "input", "artifact.pdf"),
      denied_read_canary_path: path.join(root, "denied.txt"),
      scratch_root: path.join(root, "scratch"),
      output_root: path.join(root, "output"),
      output_path: path.join(root, "output", "receipt.json"),
      tool_sha256: "a".repeat(64),
      request_sha256: "b".repeat(64),
      input_sha256: "c".repeat(64),
      config_sha256: "d".repeat(64),
      max_old_space_mb: 64,
      max_input_bytes: 1_024,
      max_output_bytes: 1_024,
      max_pages: 10,
      max_objects: 100,
      max_declared_stream_bytes: 1_024,
      max_decompressed_bytes: 4_096,
      max_decompression_ratio: 10,
      max_files: 8,
    });
    expect(Object.keys(profile.env).sort()).toEqual(parserSandboxExpectedEnvironmentKeys());
    expect(profile.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(profile.env).not.toHaveProperty("DATABASE_URL");
    expect(profile.args).toContain("--permission");
    expect(profile.args.some((value) => value.startsWith("--allow-fs-read="))).toBe(true);
    expect(profile.args.some((value) => value.startsWith("--allow-fs-write="))).toBe(true);
    expect(profile.unavailable_kernel_controls).toContain("kernel_network_namespace");
  });
});
