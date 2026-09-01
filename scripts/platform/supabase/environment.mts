import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import {
  SUPABASE_HARNESS_SCHEMA,
  type SupabaseEnvironmentBlocker,
  type SupabaseEnvironmentDetection,
} from "./contracts.mts";

const FORBIDDEN_REMOTE_ENVIRONMENT = Object.freeze([
  "DATABASE_URL",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_URL",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_SERVICE_ROLE_KEY",
]);

const REQUIRED_IMAGE_FAMILIES = Object.freeze([
  "kong",
  "postgrest/postgrest",
  "supabase/gotrue",
  "supabase/postgres",
  "supabase/realtime",
  "supabase/storage-api",
]);

export type SupabaseEnvironmentProbe = Readonly<{
  findExecutable(name: "docker" | "podman" | "supabase"): string | null;
  listCachedImages(engine: "docker" | "podman", executable: string): readonly string[];
  pathExists(path: string): boolean;
  listMigrationNames(directory: string): readonly string[];
  readText(path: string): string;
}>;

export function detectLocalSupabaseEnvironment(input: Readonly<{
  repoRoot: string;
  environment?: Readonly<Record<string, string | undefined>>;
  probe?: SupabaseEnvironmentProbe;
}>): SupabaseEnvironmentDetection {
  const probe = input.probe ?? defaultProbe(input.environment ?? process.env);
  const environment = input.environment ?? process.env;
  const repoRoot = resolve(input.repoRoot);
  const supabaseExecutable = probe.findExecutable("supabase");
  const dockerExecutable = probe.findExecutable("docker");
  const podmanExecutable = probe.findExecutable("podman");
  const engine = dockerExecutable ? "docker" : podmanExecutable ? "podman" : null;
  const engineExecutable = dockerExecutable ?? podmanExecutable;
  const engineHost = engine === "docker" ? environment.DOCKER_HOST : engine === "podman" ? environment.CONTAINER_HOST : undefined;
  const remoteContainerEngine = Boolean(engine && !localEngineHost(engineHost));
  const migrationDirectory = join(repoRoot, "supabase", "migrations");
  const migrations = probe.listMigrationNames(migrationDirectory)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const linkedMarkers = [
    join(repoRoot, ".supabase", "project-ref"),
    join(repoRoot, "supabase", ".temp", "project-ref"),
  ];
  const linkedProjectMarker = linkedMarkers.some((path) => probe.pathExists(path) && probe.readText(path).trim().length > 0);
  const remoteCredentialEnvironment = FORBIDDEN_REMOTE_ENVIRONMENT.some((key) => typeof environment[key] === "string" && environment[key]!.trim().length > 0)
    || hasNonLoopbackSupabaseUrl(environment.SUPABASE_URL);
  const cachedImages = engine && engineExecutable ? probe.listCachedImages(engine, engineExecutable) : [];
  const cachedImageFamiliesComplete = REQUIRED_IMAGE_FAMILIES.every((family) => cachedImages.some((image) => image.toLowerCase().includes(family)));
  const blockers: SupabaseEnvironmentBlocker[] = [];

  if (!supabaseExecutable) blockers.push(blocker("SUPABASE_CLI_NOT_FOUND", "No local Supabase CLI executable was found on PATH or in TIVDOC_SUPABASE_CLI_PATH.", "Provide an already-installed local Supabase CLI; do not link a remote project."));
  if (!engine) blockers.push(blocker("SUPABASE_CONTAINER_ENGINE_NOT_FOUND", "Neither a local Docker nor Podman executable was found.", "Provide an already-installed local container engine with cached Supabase images."));
  if (remoteContainerEngine) blockers.push(blocker("SUPABASE_REMOTE_CONTAINER_ENGINE_PRESENT", "The configured container-engine endpoint is not an owned loopback/local socket; it was not contacted.", "Run with no remote engine host, or point to an owned local socket."));
  if (engine && !remoteContainerEngine && !cachedImageFamiliesComplete) blockers.push(blocker("SUPABASE_REQUIRED_CACHED_IMAGES_MISSING", "The local container inventory does not contain every required Supabase service image family; network pulls are forbidden.", "Pre-cache the required Supabase images through an authorized offline process, then rerun detection."));
  if (migrations.length === 0) blockers.push(blocker("SUPABASE_MIGRATION_CHAIN_NOT_FOUND", "No ordered SQL migration chain was found under supabase/migrations.", "Restore the canonical migration chain before attempting the isolated platform runner."));
  if (remoteCredentialEnvironment) blockers.push(blocker("SUPABASE_REMOTE_CREDENTIAL_ENV_PRESENT", "One or more remote database/Supabase credential variables are present; values were not read or printed.", "Run from a scrubbed environment containing no remote credentials or URLs."));
  if (linkedProjectMarker) blockers.push(blocker("SUPABASE_REMOTE_OR_LINKED_PROJECT_PRESENT", "A non-empty Supabase project-link marker exists in the repository.", "Unlink the project outside this runner and use a generated isolated local root."));

  return Object.freeze({
    schema: SUPABASE_HARNESS_SCHEMA,
    capability_id: "MC-03",
    status: blockers.length === 0 ? "READY_FOR_EXPLICIT_LOCAL_RUN" : "BLOCKED_ENVIRONMENT",
    safety: Object.freeze({
      loopback_only: true,
      remote_project_access_allowed: false,
      remote_migration_allowed: false,
      network_pull_allowed: false,
      customer_data_allowed: false,
    }),
    discovered: Object.freeze({
      supabase_cli: Boolean(supabaseExecutable),
      container_engine: engine,
      cached_image_families_complete: cachedImageFamiliesComplete,
      migration_count: migrations.length,
      linked_project_marker: linkedProjectMarker,
      remote_credential_environment: remoteCredentialEnvironment,
    }),
    blockers: Object.freeze(blockers),
    proof_distinction: Object.freeze({
      portable_postgresql_v091: "PROVEN_SEPARATELY_NOT_SUPABASE_PLATFORM_PROOF",
      isolated_supabase_platform: "NOT_PERFORMED",
      substitution_allowed: false,
    }),
  });
}

function blocker(code: SupabaseEnvironmentBlocker["code"], exactReason: string, operatorAction: string): SupabaseEnvironmentBlocker {
  return Object.freeze({ code, exact_reason: exactReason, operator_action: operatorAction });
}

function hasNonLoopbackSupabaseUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return !["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  } catch {
    return true;
  }
}

function defaultProbe(environment: Readonly<Record<string, string | undefined>>): SupabaseEnvironmentProbe {
  return Object.freeze({
    findExecutable(name) {
      const explicit = name === "supabase" ? environment.TIVDOC_SUPABASE_CLI_PATH : undefined;
      if (explicit) {
        const candidate = resolve(explicit);
        if (isAbsolute(candidate) && safeExecutable(candidate)) return candidate;
      }
      const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
      for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
        for (const extension of extensions) {
          const candidate = join(directory, `${name}${extension}`);
          if (safeExecutable(candidate)) return realpathSync(candidate);
        }
      }
      return null;
    },
    listCachedImages(engine, executable) {
      const engineHost = engine === "docker" ? environment.DOCKER_HOST : environment.CONTAINER_HOST;
      if (!localEngineHost(engineHost)) return Object.freeze([]);
      const result = spawnSync(executable, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        env: minimalLocalProcessEnvironment(environment),
      });
      if (result.status !== 0 || result.error || typeof result.stdout !== "string") return Object.freeze([]);
      return Object.freeze(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    },
    pathExists: existsSync,
    listMigrationNames(directory) {
      try {
        return Object.freeze(readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name));
      } catch {
        return Object.freeze([]);
      }
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
  });
}

function localEngineHost(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("npipe://")
    || normalized.startsWith("unix://")
    || normalized.startsWith("tcp://127.0.0.1:")
    || normalized.startsWith("tcp://localhost:")
    || normalized.startsWith("tcp://[::1]:");
}

function minimalLocalProcessEnvironment(environment: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const allowed = ["COMSPEC", "CONTAINER_HOST", "DOCKER_HOST", "HOME", "PATH", "PATHEXT", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE"];
  return Object.fromEntries(allowed.flatMap((key) => typeof environment[key] === "string" ? [[key, environment[key]]] : []));
}

function safeExecutable(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    const parent = statSync(dirname(candidate));
    return stat.isFile() && parent.isDirectory();
  } catch {
    return false;
  }
}
