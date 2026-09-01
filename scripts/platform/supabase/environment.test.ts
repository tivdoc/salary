import { describe, expect, it } from "vitest";

import { buildSupabaseBlockerReceipt, EXPECTED_SUPABASE_PLATFORM_MATRIX } from "./contracts.mts";
import { detectLocalSupabaseEnvironment, type SupabaseEnvironmentProbe } from "./environment.mts";

const REPO_ROOT = process.platform === "win32" ? "C:\\generated\\tivdoc-repo" : "/generated/tivdoc-repo";

function probe(input: Readonly<{
  executables?: readonly ("docker" | "podman" | "supabase")[];
  images?: readonly string[];
  linked?: boolean;
  migrations?: readonly string[];
}> = {}): SupabaseEnvironmentProbe {
  return Object.freeze({
    findExecutable: (name) => input.executables?.includes(name) ? `${REPO_ROOT}/${name}` : null,
    listCachedImages: () => input.images ?? [],
    pathExists: (path) => Boolean(input.linked && path.endsWith("project-ref")),
    listMigrationNames: () => input.migrations ?? ["202608220001_salary_mvp.sql"],
    readText: () => input.linked ? "linked-project" : "",
  });
}

const COMPLETE_IMAGES = Object.freeze([
  "kong:local",
  "postgrest/postgrest:local",
  "supabase/gotrue:local",
  "supabase/postgres:local",
  "supabase/realtime:local",
  "supabase/storage-api:local",
]);

describe("MC-03 isolated Supabase safety detector", () => {
  it("emits an exact blocker matrix and never substitutes plain PostgreSQL", () => {
    const detection = detectLocalSupabaseEnvironment({ repoRoot: REPO_ROOT, environment: {}, probe: probe() });
    expect(detection.status).toBe("BLOCKED_ENVIRONMENT");
    expect(detection.blockers.map((entry) => entry.code)).toEqual(["SUPABASE_CLI_NOT_FOUND", "SUPABASE_CONTAINER_ENGINE_NOT_FOUND"]);
    expect(detection.proof_distinction).toEqual({
      portable_postgresql_v091: "PROVEN_SEPARATELY_NOT_SUPABASE_PLATFORM_PROOF",
      isolated_supabase_platform: "NOT_PERFORMED",
      substitution_allowed: false,
    });
    const receipt = buildSupabaseBlockerReceipt("verify", detection);
    expect(receipt.expected_matrix.results).toHaveLength(EXPECTED_SUPABASE_PLATFORM_MATRIX.length);
    expect(receipt.expected_matrix.results.every((entry) => entry.status === "BLOCKED_ENVIRONMENT" && !entry.plain_postgresql_substitution_used)).toBe(true);
    expect(receipt.live_provider_calls).toBe(0);
  });

  it("fails closed when remote credentials or a linked project are present", () => {
    const detection = detectLocalSupabaseEnvironment({
      repoRoot: REPO_ROOT,
      environment: { SUPABASE_ACCESS_TOKEN: "not-inspected", SUPABASE_URL: "https://remote.example" },
      probe: probe({ executables: ["supabase", "docker"], images: COMPLETE_IMAGES, linked: true }),
    });
    expect(detection.status).toBe("BLOCKED_ENVIRONMENT");
    expect(detection.blockers.map((entry) => entry.code)).toEqual([
      "SUPABASE_REMOTE_CREDENTIAL_ENV_PRESENT",
      "SUPABASE_REMOTE_OR_LINKED_PROJECT_PRESENT",
    ]);
    expect(JSON.stringify(detection)).not.toContain("not-inspected");
  });

  it("becomes ready only with the CLI, engine, cached image families and migrations", () => {
    const detection = detectLocalSupabaseEnvironment({
      repoRoot: REPO_ROOT,
      environment: { SUPABASE_URL: "http://127.0.0.1:54321" },
      probe: probe({ executables: ["supabase", "docker"], images: COMPLETE_IMAGES, migrations: ["202608220001_salary_mvp.sql", "202608310001_engine_platform_persistence.sql"] }),
    });
    expect(detection.status).toBe("READY_FOR_EXPLICIT_LOCAL_RUN");
    expect(detection.blockers).toEqual([]);
    expect(detection.discovered).toMatchObject({ container_engine: "docker", cached_image_families_complete: true, migration_count: 2 });
  });
});
