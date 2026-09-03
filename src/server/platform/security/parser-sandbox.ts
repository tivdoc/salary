import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export type ParserSandboxSpecification = Readonly<{
  network: "none";
  base_filesystem: "read_only";
  input: "single_exact_read_only_file";
  scratch: "separate_generated_writable_root";
  output: "separate_generated_writable_root";
  cpu_limit: "required";
  memory_limit: "required";
  wall_time_limit: "required";
  process_limit: "required";
  file_count_limit: "required";
  output_size_limit: "required";
  inherited_environment: "explicit_allowlist_only";
  image_or_tool_digest: "pinned_required";
  request_receipt_binding: "immutable_sha256";
  untrusted_input_visibility: "quarantine_only";
}>;

export function parserSandboxSpecification(): ParserSandboxSpecification {
  return Object.freeze({
    network: "none",
    base_filesystem: "read_only",
    input: "single_exact_read_only_file",
    scratch: "separate_generated_writable_root",
    output: "separate_generated_writable_root",
    cpu_limit: "required",
    memory_limit: "required",
    wall_time_limit: "required",
    process_limit: "required",
    file_count_limit: "required",
    output_size_limit: "required",
    inherited_environment: "explicit_allowlist_only",
    image_or_tool_digest: "pinned_required",
    request_receipt_binding: "immutable_sha256",
    untrusted_input_visibility: "quarantine_only",
  });
}

export type ParserSandboxPlatformDetection = Readonly<{
  schema_version: "tivdoc-parser-sandbox-platform-detection-v0.10.0";
  platform: NodeJS.Platform;
  architecture: string;
  node_version: string;
  node_permission_model: Readonly<{
    available: boolean;
    fs_read_allowlist: boolean;
    fs_write_allowlist: boolean;
    child_process_default_denied: boolean;
    worker_threads_default_denied: boolean;
    network_kernel_denial: false;
  }>;
  locally_detected_primitives: readonly string[];
  selected_profile: "node_permission_model_application_isolation" | "none";
  os_kernel_boundary_verified: false;
  blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED";
  blocker_reason: string;
}>;

function commandPresent(command: string) {
  const locator = process.platform === "win32" ? "where.exe" : "sh";
  const args = process.platform === "win32"
    ? [command]
    : ["-c", "command -v -- \"$1\" >/dev/null 2>&1", "sh", command];
  try {
    const result = spawnSync(locator, args, {
      windowsHide: true,
      timeout: 1_000,
      stdio: "ignore",
      env: (process.platform === "win32"
        ? { NODE_ENV: "production", Path: process.env.Path, SystemRoot: process.env.SystemRoot }
        : { NODE_ENV: "production", PATH: process.env.PATH }) as NodeJS.ProcessEnv,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Detection is deliberately read-only. A binary being present is not treated
 * as proof that its daemon, image, policy, mounts, or network namespace are
 * safe. Until a complete launch adapter is verified, owner imports stay off.
 */
export function detectLocalParserSandboxPlatform(): ParserSandboxPlatformDetection {
  const permission = process.allowedNodeEnvironmentFlags.has("--permission");
  const nodeVersionAllowed = Number(process.versions.node.split(".")[0]) === 22;
  const primitives = new Set<string>();
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot && existsSync(path.join(systemRoot, "System32", "WindowsSandbox.exe"))) primitives.add("windows_sandbox_binary");
    if (commandPresent("docker.exe")) primitives.add("docker_cli");
    if (commandPresent("podman.exe")) primitives.add("podman_cli");
  } else if (process.platform === "linux") {
    if (commandPresent("bwrap")) primitives.add("bubblewrap_binary");
    if (commandPresent("firejail")) primitives.add("firejail_binary");
    if (commandPresent("docker")) primitives.add("docker_cli");
    if (commandPresent("podman")) primitives.add("podman_cli");
  } else if (process.platform === "darwin") {
    if (commandPresent("sandbox-exec")) primitives.add("sandbox_exec_binary");
    if (commandPresent("docker")) primitives.add("docker_cli");
    if (commandPresent("podman")) primitives.add("podman_cli");
  }
  const detected = [...primitives].sort();
  const reason = !nodeVersionAllowed
    ? "NODE_VERSION_NOT_IN_EXPLICIT_V22_ALLOWLIST"
    : !permission
    ? "NODE_PERMISSION_MODEL_UNAVAILABLE_AND_NO_VERIFIED_KERNEL_PROFILE"
    : detected.length === 0
      ? "NODE_PERMISSION_MODEL_HAS_NO_KERNEL_NETWORK_OR_RESOURCE_BOUNDARY"
      : `KERNEL_PRIMITIVE_PRESENT_BUT_PINNED_LAUNCH_PROFILE_UNVERIFIED:${detected.join(",")}`;
  return Object.freeze({
    schema_version: "tivdoc-parser-sandbox-platform-detection-v0.10.0",
    platform: process.platform,
    architecture: process.arch,
    node_version: process.versions.node,
    node_permission_model: Object.freeze({
      available: permission,
      fs_read_allowlist: permission,
      fs_write_allowlist: permission,
      child_process_default_denied: permission,
      worker_threads_default_denied: permission,
      network_kernel_denial: false,
    }),
    locally_detected_primitives: Object.freeze(detected),
    selected_profile: permission && nodeVersionAllowed ? "node_permission_model_application_isolation" : "none",
    os_kernel_boundary_verified: false,
    blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    blocker_reason: reason,
  });
}

export type ParserSandboxBlockedCapability = Readonly<{
  runnable: false;
  status: "SKIPPED_BLOCKED";
  blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED";
  blocker_reason: string;
  quarantine_untrusted_inputs: true;
  persistent_owner_import_enabled: false;
  synthetic_application_profile_available: boolean;
}>;

export function localParserSandboxCapability(
  detection = detectLocalParserSandboxPlatform(),
): ParserSandboxBlockedCapability {
  return Object.freeze({
    runnable: false,
    status: "SKIPPED_BLOCKED",
    blocker_code: detection.blocker_code,
    blocker_reason: detection.blocker_reason,
    quarantine_untrusted_inputs: true,
    persistent_owner_import_enabled: false,
    synthetic_application_profile_available: detection.selected_profile === "node_permission_model_application_isolation",
  });
}

/** Retained for the frozen v0.7 capability call sites. */
export function parserSandboxCapability(preflight: Readonly<{ docker: string; supported_microvm: boolean }>): ParserSandboxBlockedCapability {
  if (preflight.docker !== "unavailable" || preflight.supported_microvm) throw new Error("PARSER_SANDBOX_CAPABILITY_REQUIRES_ORCHESTRATOR_RECHECK");
  return Object.freeze({
    runnable: false,
    status: "SKIPPED_BLOCKED",
    blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    blocker_reason: "FROZEN_PREFLIGHT_REPORTS_NO_VERIFIED_DOCKER_OR_MICROVM_PROFILE",
    quarantine_untrusted_inputs: true,
    persistent_owner_import_enabled: false,
    synthetic_application_profile_available: process.allowedNodeEnvironmentFlags.has("--permission"),
  });
}

export function assertParserMayRun(capability: Readonly<{ runnable: boolean }>): never {
  void capability;
  throw new Error("PARSER_OS_SANDBOX_REQUIRED");
}

export const parserSandboxEnvironmentAllowlist = Object.freeze([
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "NODE_ENV",
  "PATH",
  "SYSTEMDRIVE",
  "SystemRoot",
  "TEMP",
  "TIVDOC_PARSER_CONFIG_SHA256",
  "TIVDOC_PARSER_DENIED_READ_CANARY",
  "TIVDOC_PARSER_INPUT_SHA256",
  "TIVDOC_PARSER_MAX_DECLARED_STREAM_BYTES",
  "TIVDOC_PARSER_MAX_DECOMPRESSED_BYTES",
  "TIVDOC_PARSER_MAX_DECOMPRESSION_RATIO",
  "TIVDOC_PARSER_MAX_FILES",
  "TIVDOC_PARSER_MAX_INPUT_BYTES",
  "TIVDOC_PARSER_MAX_OBJECTS",
  "TIVDOC_PARSER_MAX_OUTPUT_BYTES",
  "TIVDOC_PARSER_MAX_PAGES",
  "TIVDOC_PARSER_NETWORK_DISABLED",
  "TIVDOC_PARSER_REQUEST_SHA256",
  "TIVDOC_PARSER_TEST_BEHAVIOR",
  "TIVDOC_PARSER_TOOL_SHA256",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
] as const);

const parserSandboxRequiredEnvironmentKeys = Object.freeze([
  "NODE_ENV",
  "TIVDOC_PARSER_CONFIG_SHA256",
  "TIVDOC_PARSER_DENIED_READ_CANARY",
  "TIVDOC_PARSER_INPUT_SHA256",
  "TIVDOC_PARSER_MAX_DECLARED_STREAM_BYTES",
  "TIVDOC_PARSER_MAX_DECOMPRESSED_BYTES",
  "TIVDOC_PARSER_MAX_DECOMPRESSION_RATIO",
  "TIVDOC_PARSER_MAX_FILES",
  "TIVDOC_PARSER_MAX_INPUT_BYTES",
  "TIVDOC_PARSER_MAX_OBJECTS",
  "TIVDOC_PARSER_MAX_OUTPUT_BYTES",
  "TIVDOC_PARSER_MAX_PAGES",
  "TIVDOC_PARSER_NETWORK_DISABLED",
  "TIVDOC_PARSER_REQUEST_SHA256",
  "TIVDOC_PARSER_TOOL_SHA256",
] as const);

const parserSandboxWindowsEnvironmentKeys = Object.freeze([
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SystemRoot",
  "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
] as const);

export function parserSandboxExpectedEnvironmentKeys(testBehavior?: string) {
  return Object.freeze([
    ...parserSandboxRequiredEnvironmentKeys,
    ...(process.platform === "win32" ? parserSandboxWindowsEnvironmentKeys : []),
    ...(testBehavior ? ["TIVDOC_PARSER_TEST_BEHAVIOR"] : []),
  ].sort());
}

export type NodePermissionParserLaunchProfile = Readonly<{
  schema_version: "tivdoc-node-permission-parser-profile-v0.10.0";
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  enforced: readonly string[];
  cooperative_only: readonly string[];
  unavailable_kernel_controls: readonly string[];
}>;

export const parserSandboxNodeMajorAllowlist = Object.freeze([22] as const);

function assertAbsoluteDistinct(paths: readonly string[]) {
  const normalized = paths.map((value) => {
    if (!path.isAbsolute(value)) throw new Error("PARSER_PROFILE_PATH_NOT_ABSOLUTE");
    return path.resolve(value).toLocaleLowerCase("en-US");
  });
  if (new Set(normalized).size !== normalized.length) throw new Error("PARSER_PROFILE_PATHS_NOT_DISTINCT");
}

export function buildNodePermissionParserLaunchProfile(input: Readonly<{
  worker_path: string;
  request_path: string;
  input_path: string;
  denied_read_canary_path: string;
  scratch_root: string;
  output_root: string;
  output_path: string;
  tool_sha256: string;
  request_sha256: string;
  input_sha256: string;
  config_sha256: string;
  max_old_space_mb: number;
  max_input_bytes: number;
  max_output_bytes: number;
  max_pages: number;
  max_objects: number;
  max_declared_stream_bytes: number;
  max_decompressed_bytes: number;
  max_decompression_ratio: number;
  max_files: number;
  test_behavior?: string;
}>): NodePermissionParserLaunchProfile {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) throw new Error("PARSER_NODE_PERMISSION_MODEL_UNAVAILABLE");
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!(parserSandboxNodeMajorAllowlist as readonly number[]).includes(nodeMajor)) throw new Error("PARSER_NODE_VERSION_NOT_ALLOWLISTED");
  for (const value of [input.tool_sha256, input.request_sha256, input.input_sha256, input.config_sha256]) {
    if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("PARSER_PROFILE_SHA256_INVALID");
  }
  assertAbsoluteDistinct([input.request_path, input.input_path, input.denied_read_canary_path, input.scratch_root, input.output_root]);
  const resolvedOutput = path.resolve(input.output_path);
  const relativeOutput = path.relative(path.resolve(input.output_root), resolvedOutput);
  if (!relativeOutput || relativeOutput.startsWith("..") || path.isAbsolute(relativeOutput)) throw new Error("PARSER_PROFILE_OUTPUT_ESCAPE");
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  const drive = path.parse(input.scratch_root).root.replace(/[\\/]$/u, "");
  const windowsEnvironment: Record<string, string | undefined> = process.platform === "win32" ? {
    HOMEDRIVE: drive,
    HOMEPATH: `\\${path.relative(`${drive}\\`, input.scratch_root)}`,
    LOGONSERVER: "TIVDOC_PARSER",
    PATH: "",
    SYSTEMDRIVE: drive,
    SystemRoot: windowsRoot,
    TEMP: input.scratch_root,
    TMP: input.scratch_root,
    USERDOMAIN: "TIVDOC_PARSER",
    USERNAME: "TIVDOC_PARSER",
    USERPROFILE: input.scratch_root,
    WINDIR: windowsRoot,
  } : {};
  const env = {
    NODE_ENV: "production",
    ...windowsEnvironment,
    TIVDOC_PARSER_CONFIG_SHA256: input.config_sha256,
    TIVDOC_PARSER_DENIED_READ_CANARY: input.denied_read_canary_path,
    TIVDOC_PARSER_INPUT_SHA256: input.input_sha256,
    TIVDOC_PARSER_MAX_DECLARED_STREAM_BYTES: String(input.max_declared_stream_bytes),
    TIVDOC_PARSER_MAX_DECOMPRESSED_BYTES: String(input.max_decompressed_bytes),
    TIVDOC_PARSER_MAX_DECOMPRESSION_RATIO: String(input.max_decompression_ratio),
    TIVDOC_PARSER_MAX_FILES: String(input.max_files),
    TIVDOC_PARSER_MAX_INPUT_BYTES: String(input.max_input_bytes),
    TIVDOC_PARSER_MAX_OBJECTS: String(input.max_objects),
    TIVDOC_PARSER_MAX_OUTPUT_BYTES: String(input.max_output_bytes),
    TIVDOC_PARSER_MAX_PAGES: String(input.max_pages),
    TIVDOC_PARSER_NETWORK_DISABLED: "1",
    TIVDOC_PARSER_REQUEST_SHA256: input.request_sha256,
    TIVDOC_PARSER_TOOL_SHA256: input.tool_sha256,
    ...(input.test_behavior ? { TIVDOC_PARSER_TEST_BEHAVIOR: input.test_behavior } : {}),
  };
  const unexpected = Object.keys(env).filter((key) => !(parserSandboxEnvironmentAllowlist as readonly string[]).includes(key));
  if (unexpected.length > 0) throw new Error("PARSER_PROFILE_ENVIRONMENT_NOT_ALLOWLISTED");
  if (JSON.stringify(Object.keys(env).sort()) !== JSON.stringify(parserSandboxExpectedEnvironmentKeys(input.test_behavior))) {
    throw new Error("PARSER_PROFILE_ENVIRONMENT_KEYS_INCOMPLETE");
  }
  return Object.freeze({
    schema_version: "tivdoc-node-permission-parser-profile-v0.10.0",
    executable: process.execPath,
    args: Object.freeze([
      "--permission",
      `--allow-fs-read=${input.worker_path}`,
      `--allow-fs-read=${input.request_path}`,
      `--allow-fs-read=${input.input_path}`,
      `--allow-fs-write=${input.scratch_root}`,
      `--allow-fs-write=${input.output_root}`,
      `--max-old-space-size=${input.max_old_space_mb}`,
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      input.worker_path,
      input.request_path,
      input.input_path,
      input.scratch_root,
      input.output_path,
    ]),
    cwd: input.scratch_root,
    env: Object.freeze(env) as NodeJS.ProcessEnv,
    enforced: Object.freeze([
      "node_permission_fs_read_allowlist",
      "node_permission_fs_write_allowlist",
      "node_permission_child_process_denial",
      "node_permission_worker_thread_denial",
      "v8_old_space_limit",
      "parent_wall_timeout_and_forced_termination",
      "parent_output_and_file_count_validation",
      "explicit_environment_allowlist",
    ]),
    cooperative_only: Object.freeze(["cpu_time_limit", "network_api_denial"]),
    unavailable_kernel_controls: Object.freeze([
      "kernel_network_namespace",
      "kernel_cpu_quota",
      "kernel_rss_limit",
      "kernel_pid_namespace_or_job_object",
      "read_only_kernel_root_filesystem",
    ]),
  });
}

// Wave 6 (K-4). What would close PARSER_OS_SANDBOX_NOT_VERIFIED, written as a
// contract rather than a wish: the four proofs a launch adapter must present —
// a pinned image, a kernel isolation boundary, a demonstrated absence of
// network, and a pinned toolchain — each with the artefact that proves it and
// the check the runtime performs before a parser is allowed to run. Nothing
// below is claimed to exist; the detector above keeps saying so until every
// proof is presented and verified.

export type ParserIsolationPinnedTool = Readonly<{
  tool: string;
  version: string;
  sha256: string | null;
  byte_count: number | null;
  locator_class: "interpreter" | "python_package" | "native_binary" | "model_data";
  observed_on_host: boolean;
}>;

export type ParserIsolationProof = Readonly<{
  proof: "pinned_image" | "kernel_isolation" | "no_network" | "pinned_toolchain";
  requirement: string;
  artefact: string;
  runtime_check: string;
  acceptable_implementations: readonly string[];
  status: "NOT_VERIFIED";
}>;

export type ParserIsolationClosingEnvironment = Readonly<{
  schema_version: "tivdoc-parser-isolation-closing-environment-v0.10.0";
  blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED";
  closes_when: "every proof below is presented, verified by the runtime check, and bound into the parse receipt";
  proofs: readonly [ParserIsolationProof, ParserIsolationProof, ParserIsolationProof, ParserIsolationProof];
  resource_limits: Readonly<{
    cpu: "hard limit by cgroup or job object, not cooperative";
    memory: "hard RSS limit; the parser is killed, not warned";
    wall_time: "hard timeout; the whole process tree is killed";
    processes: "pid limit of one parser process and its interpreter";
    files: "read-only rootfs; one input file; one scratch root; one output root; file-count and output-size caps";
    user: "non-root, no capabilities";
    syscalls: "seccomp or equivalent allowlist profile, pinned by digest";
  }>;
  toolchain_pins: readonly ParserIsolationPinnedTool[];
  receipt_binding: "input sha256, tool digests, image digest, profile digest and limits are hashed into the parse receipt";
}>;

export function parserIsolationClosingEnvironment(
  toolchain: readonly ParserIsolationPinnedTool[],
): ParserIsolationClosingEnvironment {
  const proofs = [
    Object.freeze({
      proof: "pinned_image" as const,
      requirement: "The parser runs from an OCI image addressed by digest, never by tag, built from a pinned base with the toolchain below and nothing else.",
      artefact: "image digest (sha256) and the SBOM of the image, both recorded in the launch profile",
      runtime_check: "the launcher refuses any image reference that is not a digest and any digest not in the pinned launch profile",
      acceptable_implementations: Object.freeze(["distroless or scratch image with a pinned Python 3.13 runtime", "reproducible build with recorded provenance"]),
      status: "NOT_VERIFIED" as const,
    }),
    Object.freeze({
      proof: "kernel_isolation" as const,
      requirement: "A kernel or hypervisor boundary between the parser and the host, so a parser escape is a VM or sandboxed-kernel escape and not a process escape.",
      artefact: "the runtime's own attestation of the boundary (gVisor runsc version and platform, Kata/Firecracker VM config, or Hyper-V isolated container config) recorded in the launch profile",
      runtime_check: "the launcher reads the boundary attestation before launch and refuses when it is absent or not one of the accepted implementations",
      acceptable_implementations: Object.freeze(["gVisor (runsc) with the ptrace or KVM platform", "Kata Containers or Firecracker microVM", "Hyper-V isolated container on Windows Server"]),
      status: "NOT_VERIFIED" as const,
    }),
    Object.freeze({
      proof: "no_network" as const,
      requirement: "No network reachable from inside the boundary: no interfaces except loopback, no DNS, no egress, proven, not configured.",
      artefact: "an egress probe run inside the boundary before the parser, recording that every outbound attempt (TCP, UDP, DNS) failed, and the interface list showing loopback only",
      runtime_check: "the probe's receipt is required in the launch profile and re-run on every launch; a single successful outbound attempt aborts the launch",
      acceptable_implementations: Object.freeze(["network namespace with no veth (--network none)", "microVM with no network device"]),
      status: "NOT_VERIFIED" as const,
    }),
    Object.freeze({
      proof: "pinned_toolchain" as const,
      requirement: "Every tool the parser executes is pinned by digest, and the digests observed inside the boundary equal the pinned ones.",
      artefact: "the toolchain pin list below, with sha256 and byte count for the interpreter, each Python package wheel, the OCR binary, and the model data",
      runtime_check: "the launcher hashes the interpreter, the installed package files, the OCR binary and the model data inside the boundary and refuses on any mismatch",
      acceptable_implementations: Object.freeze(["pip install --require-hashes from a locked requirements file", "tesseract and traineddata copied into the image and hashed at build"]),
      status: "NOT_VERIFIED" as const,
    }),
  ] as const;
  return Object.freeze({
    schema_version: "tivdoc-parser-isolation-closing-environment-v0.10.0",
    blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED",
    closes_when: "every proof below is presented, verified by the runtime check, and bound into the parse receipt",
    proofs,
    resource_limits: Object.freeze({
      cpu: "hard limit by cgroup or job object, not cooperative",
      memory: "hard RSS limit; the parser is killed, not warned",
      wall_time: "hard timeout; the whole process tree is killed",
      processes: "pid limit of one parser process and its interpreter",
      files: "read-only rootfs; one input file; one scratch root; one output root; file-count and output-size caps",
      user: "non-root, no capabilities",
      syscalls: "seccomp or equivalent allowlist profile, pinned by digest",
    }),
    toolchain_pins: Object.freeze(toolchain.map((tool) => Object.freeze({ ...tool }))),
    receipt_binding: "input sha256, tool digests, image digest, profile digest and limits are hashed into the parse receipt",
  });
}
