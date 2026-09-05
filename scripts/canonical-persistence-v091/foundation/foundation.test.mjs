import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyCompatibilityBootstrap,
  applyCleanMigrationChain,
  authorizeOwnedControl,
  CANONICAL_COMPOSITION_MIGRATION_SHA256,
  createOwnedLocalTarget,
  discoverMigrationChain,
  inspectExplicitDynamicTarget,
  inspectRepositorySourceSafety,
  EXPECTED_MIGRATION_SHA256,
  parseInventory,
  parseProvenance,
  PINNED_BINARY_SHA256,
  PINNED_EDB_ARCHIVE_SHA256,
  PINNED_EDB_ARCHIVE_URL,
  PINNED_DISTRIBUTION_BYTES,
  PINNED_DISTRIBUTION_FILE_COUNT,
  PINNED_DISTRIBUTION_TREE_SHA256,
  redact,
  renderPgHba,
  renderPostgresqlConfig,
  resolveDynamicPostgresPaths,
  selectRandomHighLoopbackPort,
} from "./index.mts";
import {
  assertCredentialFreeEvidence,
} from "../evidence/credential-scan.mts";
import {
  crc32,
  inspectDeterministicStoreZip,
  writeDeterministicStoreZip,
} from "../evidence/deterministic-zip.mts";

const password = "p".repeat(40);
const token = "a".repeat(64);

function ownedTarget() {
  return createOwnedLocalTarget({
    port: 45_432,
    suffix: "abcdefgh",
    username: "tivdoc_dynamic_admin",
    password,
    ownership_token: token,
  });
}

// L9-7: the V0.9.1 foundation pins the Windows Git toolchain and the working copy's bytes by design; on another host it says so and skips.
describe.skipIf(process.platform !== "win32")("V0.9.1 dynamic PostgreSQL foundation", () => {
  it("rejects decoded JSON credential forms and provider tokens in evidence", () => {
    expect(() => assertCredentialFreeEvidence('{"note":"postgresql:\\/\\/user:password@127.0.0.1/test"}'))
      .toThrow("DYNAMIC_EVIDENCE_CREDENTIAL_PATTERN_REJECTED");
    expect(() => assertCredentialFreeEvidence('{"\\u0070rivate_key":"escaped-field"}'))
      .toThrow("DYNAMIC_EVIDENCE_SECRET_FIELD_DETECTED");
    expect(() => assertCredentialFreeEvidence(JSON.stringify({ "x-api-key": "escaped-field" })))
      .toThrow("DYNAMIC_EVIDENCE_SECRET_FIELD_DETECTED");
    expect(() => assertCredentialFreeEvidence(JSON.stringify({ note: `AIza${"A".repeat(32)}` })))
      .toThrow("DYNAMIC_EVIDENCE_CREDENTIAL_PATTERN_REJECTED");
    expect(() => assertCredentialFreeEvidence(JSON.stringify({ sha256: "a".repeat(64), credentials_recorded: 0 })))
      .not.toThrow();
  });

  it("writes and strictly inspects deterministic Node-only STORE ZIP evidence", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "tivdoc-v091-zip-"));
    try {
      const source = join(temporary, "source");
      await mkdir(join(source, "nested"), { recursive: true });
      await writeFile(join(source, "b.json"), "{\"b\":2}\n");
      await writeFile(join(source, "nested", "a.json"), "{\"a\":1}\n");
      const entries = ["b.json", "nested/a.json"];
      expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
      const first = join(temporary, "first.zip");
      const second = join(temporary, "second.zip");
      await writeDeterministicStoreZip({ root: source, output: first, entries });
      await writeDeterministicStoreZip({ root: source, output: second, entries });

      const firstBytes = await readFile(first);
      expect(firstBytes).toEqual(await readFile(second));
      const inspection = await inspectDeterministicStoreZip(first);
      expect(inspection.entry_count).toBe(2);
      expect(inspection.entries.map((entry) => entry.path)).toEqual(entries);
      expect(inspection.entries.every((entry) => entry.compression === 0
        && entry.compressed_byte_count === entry.byte_count
        && entry.create_system === 3
        && entry.external_attr === 0o100644 * 65_536
        && JSON.stringify(entry.date_time) === "[1980,1,1,0,0,0]"))
        .toBe(true);

      const tampered = Buffer.from(firstBytes);
      const firstContentOffset = 30 + tampered.readUInt16LE(26);
      tampered[firstContentOffset] = tampered[firstContentOffset] ^ 1;
      const tamperedPath = join(temporary, "tampered.zip");
      await writeFile(tamperedPath, tampered);
      await expect(inspectDeterministicStoreZip(tamperedPath)).rejects.toThrow("DYNAMIC_ZIP_CRC32_MISMATCH");
      await expect(writeDeterministicStoreZip({
        root: source,
        output: join(temporary, "unsafe.zip"),
        entries: ["../escape.json"],
      })).rejects.toThrow("DYNAMIC_ZIP_ENTRY_NAME_UNSAFE");
      await expect(writeDeterministicStoreZip({
        root: source,
        output: join(temporary, "windows-unsafe.zip"),
        entries: ["CON.json"],
      })).rejects.toThrow("DYNAMIC_ZIP_ENTRY_NAME_UNSAFE");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("accepts only the explicit Tivdoc loopback target and emits no credentials", () => {
    const url = `postgresql://tivdoc_user:${password}@127.0.0.1:45432/tivdoc_v09_abcdefgh?sslmode=disable&application_name=tivdoc-dynamic-v0.9.1`;
    const approved = inspectExplicitDynamicTarget({ TIVDOC_DYNAMIC_POSTGRES_URL: url });
    expect(approved.receipt).toMatchObject({
      approved: true,
      reason: "approved_explicit_loopback_target",
      credentials_emitted: 0,
      generic_database_environment_keys_read: 0,
    });
    expect(approved.target?.descriptor.database).toBe("tivdoc_v09_abcdefgh");
    expect(JSON.stringify(approved)).not.toContain(password);
    expect(JSON.stringify(approved)).not.toContain("tivdoc_user");
  });

  it("rejects remote, generic, Production-like and option-rich targets", () => {
    expect(inspectExplicitDynamicTarget({
      TIVDOC_DYNAMIC_POSTGRES_URL: `postgresql://u:${password}@db.example/tivdoc_v09_abcdefgh`,
    }).receipt.reason).toBe("non_loopback_target_rejected");
    expect(inspectExplicitDynamicTarget({
      TIVDOC_DYNAMIC_POSTGRES_URL: `postgresql://u:${password}@127.0.0.1/postgres`,
    }).receipt.reason).toBe("database_name_invalid");
    expect(inspectExplicitDynamicTarget({
      TIVDOC_DYNAMIC_POSTGRES_URL: `postgresql://u:${password}@127.0.0.1/tivdoc_v09_prod_live`,
    }).receipt.reason).toBe("production_like_database_rejected");
    expect(inspectExplicitDynamicTarget({
      TIVDOC_DYNAMIC_POSTGRES_URL: `postgresql://u:${password}@127.0.0.1/tivdoc_v09_abcdefgh?target_session_attrs=read-write`,
    }).receipt.reason).toBe("unsupported_connection_option");
  });

  it("creates a strongly owned local identity without serializing secrets", () => {
    const target = ownedTarget();
    expect(target.descriptor).toMatchObject({
      host: "127.0.0.1",
      port: 45_432,
      database: "tivdoc_v09_abcdefgh",
      target_id: "tivdoc-v09-abcdefgh",
      destructive_control_authorized: true,
    });
    expect(authorizeOwnedControl(target, target.marker)).toBe(true);
    expect(authorizeOwnedControl(target, { ...target.marker, port: 45_433 })).toBe(false);
    expect(JSON.stringify(target)).not.toContain(password);
    expect(JSON.stringify(target)).not.toContain(token);
  });

  it("resolves the official archive distribution and owned runtime beneath approved roots", () => {
    const paths = resolveDynamicPostgresPaths(process.cwd(), ownedTarget());
    expect(paths.distribution_root.replaceAll("\\", "/")).toMatch(/\/\.tools\/postgresql\/17\.11-2-official-zip$/);
    expect(paths.binaries_root.replaceAll("\\", "/")).toMatch(/\/17\.11-2-official-zip\/bin$/);
    expect(paths.cluster_root.replaceAll("\\", "/")).toMatch(/\/\.tmp\/postgresql-dynamic-v0\.9\.1\/tivdoc-v09-abcdefgh$/);
  });

  it("renders loopback-only SCRAM/UTC configuration and selects only the high range", async () => {
    const config = renderPostgresqlConfig(ownedTarget());
    const hba = renderPgHba();
    expect(config).toContain("listen_addresses = '127.0.0.1'");
    expect(config).toContain("timezone = 'UTC'");
    expect(config).toContain("password_encryption = 'scram-sha-256'");
    expect(hba).toContain("127.0.0.1/32 scram-sha-256");
    expect(hba).not.toContain(" trust");
    const port = await selectRandomHighLoopbackPort({
      random_integer: () => 45_678,
      available: async (candidate) => candidate === 45_678,
    });
    expect(port).toBe(45_678);
  });

  it("requires the pinned official 17.11 EDB archive provenance and exact binary hashes", () => {
    const provenance = parseProvenance(JSON.stringify({
      schema_version: "tivdoc-pinned-postgresql-provenance-v0.9.1",
      postgres_version: "17.11",
      architecture: "x64",
      source_kind: "edb_official_windows_binaries_zip",
      source_url: PINNED_EDB_ARCHIVE_URL,
      source_sha256: PINNED_EDB_ARCHIVE_SHA256,
      source_integrity: "PINNED_SHA256_OFFICIAL_HTTPS",
      distribution_file_count: PINNED_DISTRIBUTION_FILE_COUNT,
      distribution_bytes: PINNED_DISTRIBUTION_BYTES,
      distribution_tree_sha256: PINNED_DISTRIBUTION_TREE_SHA256,
      binary_sha256: PINNED_BINARY_SHA256,
    }));
    expect(provenance.source_sha256).toBe(PINNED_EDB_ARCHIVE_SHA256);
    expect(() => parseProvenance(JSON.stringify({ ...provenance, source_url: "https://example.com/postgres.exe" })))
      .toThrow("POSTGRES_PROVENANCE_SOURCE_REJECTED");
  });

  it("discovers the exact migration chain and canonical checksum", async () => {
    const paths = resolveDynamicPostgresPaths(process.cwd(), ownedTarget());
    const chain = await discoverMigrationChain(paths);
    expect(chain.migration_count).toBe(57);
    expect(Object.fromEntries(chain.migrations.map(({ name, sha256 }) => [name, sha256])))
      .toEqual(EXPECTED_MIGRATION_SHA256);
    expect(chain.canonical_migration_sha256).toBe(CANONICAL_COMPOSITION_MIGRATION_SHA256);
    expect(chain.migrations.find((migration) => migration.name === "202608310002_canonical_postgresql_composition.sql")?.sha256)
      .toBe(CANONICAL_COMPOSITION_MIGRATION_SHA256);
  });

  it("builds bootstrap and migration execution without credentials in arguments or receipts", async () => {
    const target = ownedTarget();
    const paths = resolveDynamicPostgresPaths(process.cwd(), target);
    const chain = await discoverMigrationChain(paths);
    const commands = [];
    const runner = async (command) => {
      commands.push(command);
      return Object.freeze({
        executable_name: "psql.exe",
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        duration_ms: 1,
        credentials_emitted: 0,
      });
    };
    const binaries = { executable_paths: { psql: `${process.cwd()}\\fake\\psql.exe` } };
    const bootstrap = await applyCompatibilityBootstrap({ target, paths, binaries, runner });
    const migrations = await applyCleanMigrationChain({ target, paths, binaries, chain, runner });
    expect(bootstrap.applied_count).toBe(1);
    expect(migrations.applied_count).toBe(57);
    expect(commands).toHaveLength(58);
    expect(commands.every((command) => command.args.every((argument) => !argument.includes(password)))).toBe(true);
    expect(JSON.stringify({ bootstrap, migrations })).not.toContain(password);
  });

  it("keeps the compatibility SQL minimal and explicitly non-Supabase proof", async () => {
    const paths = resolveDynamicPostgresPaths(process.cwd(), ownedTarget());
    const sql = await readFile(paths.bootstrap_sql, "utf8");
    expect(sql).toContain("array['anon', 'authenticated', 'service_role']");
    expect(sql).toContain("create schema if not exists storage");
    expect(sql).toContain("create table if not exists storage.buckets");
    expect(sql).not.toMatch(/create\s+schema\s+(?:if\s+not\s+exists\s+)?auth\b/i);
    expect(sql).toContain("not Supabase platform proof");
  });

  it("redacts raw, encoded and URL credentials and parses a single inventory document", () => {
    const raw = `failure ${password} ${encodeURIComponent(password)} postgresql://user:${password}@127.0.0.1/db`;
    const safe = redact(raw, [password]);
    expect(safe).not.toContain(password);
    expect(safe).toContain("postgresql://[REDACTED]@127.0.0.1/db");
    expect(parseInventory('{"schemas":["public"]}\n')).toEqual({ schemas: ["public"] });
    expect(() => parseInventory('{}\n{}\n')).toThrow("POSTGRES_INVENTORY_OUTPUT_INVALID");
  });

  it("scans staged Git blobs across secret formats and UTF-16 byte order", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "tivdoc-v091-preflight-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: temporary, windowsHide: true });
      const providerToken = ["sk", "-proj-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"].join("");
      const utf16Le = Buffer.from(`${"א".repeat(2_000)} ${providerToken} סוף`, "utf16le");
      const utf16Be = Buffer.from(utf16Le);
      utf16Be.swap16();
      await writeFile(join(temporary, "utf16-le.bin"), utf16Le);
      await writeFile(join(temporary, "utf16-be.bin"), utf16Be);
      await writeFile(join(temporary, "credentials.txt"), [
        ["-----BEGIN ENCRYPTED ", "PRIVATE KEY-----"].join(""),
        ["github", "_pat_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_abcdefgh"].join(""),
        ["AS", "IA", "ABCDEFGHIJKLMNOP"].join(""),
      ].join("\n"));
      execFileSync("git", ["add", "."], { cwd: temporary, windowsHide: true });
      const result = await inspectRepositorySourceSafety(temporary);
      expect(result.tracked_text_files_scanned).toBeGreaterThanOrEqual(1);
      expect(result.untracked_text_files_scanned).toBe(0);
      expect(result.secrets_detected).toBeGreaterThanOrEqual(5);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("detects mixed-case, uppercase and post-placeholder secrets", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "tivdoc-v091-preflight-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: temporary, windowsHide: true });
      await writeFile(join(temporary, "generic.txt"), [
        ["SESSION", "_SECRET=", "Ab9Kp2Qx7Vm4Ls8Rw3Yt6Nc1"].join(""),
        "OPENAI_API_KEY=sk-your-example-api-key-placeholder",
        ["sk", "-proj-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"].join(""),
        ["SESSION", "_TOKEN=", "ABCDEFGH234567IJKLMNOPQRSTUVWXYZ"].join(""),
      ].join("\n"));
      execFileSync("git", ["add", "."], { cwd: temporary, windowsHide: true });
      const result = await inspectRepositorySourceSafety(temporary);
      expect(result.secrets_detected).toBe(3);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("keeps the repository-wide committed source scan at zero findings", async () => {
    const result = await inspectRepositorySourceSafety(process.cwd());
    expect(result.secrets_detected).toBe(0);
    expect(result.local_environment_files).toEqual([]);
    expect(result.customer_artifacts_tracked).toBe(0);
  });

  it("rejects nested local environment files, allows examples, and fails closed above 64 MiB", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "tivdoc-v091-preflight-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: temporary, windowsHide: true });
      await writeFile(join(temporary, "safe.txt"), "safe\n");
      execFileSync("git", ["add", "safe.txt"], { cwd: temporary, windowsHide: true });
      await mkdir(join(temporary, "apps", "web"), { recursive: true });
      await writeFile(join(temporary, "apps", "web", ".env.local.example"), "SAFE_TEMPLATE=placeholder\n");
      await writeFile(join(temporary, "apps", "web", ".env.local"), "LOCAL_ONLY=placeholder\n");
      await writeFile(join(temporary, "apps", "web", ".ENV.SECRET"), "LOCAL_ONLY=placeholder\n");
      const environmentResult = await inspectRepositorySourceSafety(temporary);
      expect(environmentResult.local_environment_files).toEqual(["apps/web/.ENV.SECRET", "apps/web/.env.local"]);

      await rm(join(temporary, "apps", "web", ".env.local"));
      await rm(join(temporary, "apps", "web", ".ENV.SECRET"));
      const large = await open(join(temporary, "large-untracked.bin"), "w");
      try {
        await large.truncate(64 * 1024 * 1024 + 1);
      } finally {
        await large.close();
      }
      await expect(inspectRepositorySourceSafety(temporary)).rejects.toThrow("DYNAMIC_PREFLIGHT_SOURCE_FILE_TOO_LARGE");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
