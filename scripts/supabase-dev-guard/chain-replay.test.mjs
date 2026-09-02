import { describe, expect, it } from "vitest";

import { CHAIN_REPLAY_SCHEMA, discoverMigrationFiles, replayMigrationChain } from "./chain-replay.mts";
import { DENIED_PROJECT_REFS, TIVDOC_DEV_LABEL, TIVDOC_DEV_PROJECT_REF } from "./guard.mts";

const MIGRATIONS = "supabase/migrations";
const DEV_ENV = { SUPABASE_PROJECT_REF: TIVDOC_DEV_PROJECT_REF, SUPABASE_PROJECT_LABEL: TIVDOC_DEV_LABEL };

describe("V0.10.9 byte-pinned chain replay", () => {
  it("discovers every migration in filename order with LF-normalized hashes", async () => {
    const files = await discoverMigrationFiles(MIGRATIONS);
    expect(files.length).toBeGreaterThanOrEqual(23);
    expect(files.map((file) => file.name)).toEqual([...files.map((file) => file.name)].sort());
    expect(files.at(-1)?.name).toBe("202609020005_controlled_import_reserved_execute_revoke.sql");
    for (const file of files) {
      expect(file.sha256_raw).toMatch(/^[a-f0-9]{64}$/u);
      expect(file.sha256_lf).toMatch(/^[a-f0-9]{64}$/u);
      expect(file.byte_count).toBeGreaterThan(0);
    }
    expect(files.map((file) => file.applied_order)).toEqual(files.map((_, index) => index + 1));
  });

  it("hashes the bytes it will send, matching the repository pin for the legal review migration", async () => {
    const { EXPECTED_MIGRATION_SHA256 } = await import(
      "../canonical-persistence-v091/foundation/migrations.mts"
    );
    const files = await discoverMigrationFiles(MIGRATIONS);
    const pinnedFiles = files.filter((file) => EXPECTED_MIGRATION_SHA256[file.name]);
    expect(pinnedFiles.length).toBeGreaterThanOrEqual(23);
    for (const file of pinnedFiles) {
      const pinned = EXPECTED_MIGRATION_SHA256[file.name];
      // The pin must match the bytes on disk under one of the two conventions
      // the repository actually uses; neither matching means the file drifted.
      expect([file.sha256_raw, file.sha256_lf], file.name).toContain(pinned);
    }
  });

  it("refuses to run without a DEV credential rather than falling back", async () => {
    const receipt = await replayMigrationChain({ migrations_root: MIGRATIONS, environment: DEV_ENV });
    expect(receipt.schema_version).toBe(CHAIN_REPLAY_SCHEMA);
    expect(receipt.status).toBe("BLOCKED_NO_CREDENTIAL");
    expect(receipt.blocked_reason).toBe("TIVDOC_DEV_DATABASE_URL_ABSENT");
    expect(receipt.files_applied).toBe(0);
    expect(receipt.project_ref_verified).toBe(true);
  });

  it("runs the guard before anything else and refuses a denied or absent ref", async () => {
    await expect(replayMigrationChain({ migrations_root: MIGRATIONS, environment: {} }))
      .rejects.toThrow(/PROJECT_REF_MISSING/u);
    await expect(replayMigrationChain({
      migrations_root: MIGRATIONS,
      environment: { SUPABASE_PROJECT_REF: DENIED_PROJECT_REFS[0], SUPABASE_PROJECT_LABEL: TIVDOC_DEV_LABEL },
    })).rejects.toThrow(/PROJECT_REF_DENYLISTED/u);
    await expect(replayMigrationChain({
      migrations_root: MIGRATIONS,
      environment: { SUPABASE_PROJECT_REF: TIVDOC_DEV_PROJECT_REF, SUPABASE_PROJECT_LABEL: "PRODUCTION" },
    })).rejects.toThrow(/DEV_LABEL_MISSING/u);
  });

  it("never returns a connection string or password in the receipt", async () => {
    const receipt = await replayMigrationChain({
      migrations_root: MIGRATIONS,
      environment: { ...DEV_ENV, TIVDOC_DEV_DATABASE_URL: "" },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//u);
    expect(Object.keys(receipt)).not.toContain("connection_string");
  });
});
