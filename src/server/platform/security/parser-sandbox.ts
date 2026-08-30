export type ParserSandboxSpecification = Readonly<{
  network: "none";
  base_filesystem: "read_only";
  output: "generated_temporary_root";
  cpu_limit: "required";
  memory_limit: "required";
  wall_time_limit: "required";
  process_limit: "required";
  image_or_tool_digest: "pinned_required";
  untrusted_input_visibility: "quarantine_only";
}>;

export function parserSandboxSpecification(): ParserSandboxSpecification {
  return Object.freeze({
    network: "none",
    base_filesystem: "read_only",
    output: "generated_temporary_root",
    cpu_limit: "required",
    memory_limit: "required",
    wall_time_limit: "required",
    process_limit: "required",
    image_or_tool_digest: "pinned_required",
    untrusted_input_visibility: "quarantine_only",
  });
}

export function parserSandboxCapability(preflight: Readonly<{ docker: string; supported_microvm: boolean }>): Readonly<{
  runnable: false;
  status: "SKIPPED_BLOCKED";
  blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED";
  quarantine_untrusted_inputs: true;
}> {
  if (preflight.docker !== "unavailable" || preflight.supported_microvm) throw new Error("PARSER_SANDBOX_CAPABILITY_REQUIRES_ORCHESTRATOR_RECHECK");
  return Object.freeze({ runnable: false, status: "SKIPPED_BLOCKED", blocker_code: "PARSER_OS_SANDBOX_NOT_VERIFIED", quarantine_untrusted_inputs: true });
}

export function assertParserMayRun(capability: ReturnType<typeof parserSandboxCapability>): never {
  void capability;
  throw new Error("PARSER_OS_SANDBOX_REQUIRED");
}
