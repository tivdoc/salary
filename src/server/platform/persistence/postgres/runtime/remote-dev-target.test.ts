import { describe, expect, it } from "vitest";

import {
  deriveNodePostgresTargetDescriptor,
  validateNodePostgresConnection,
  type NodePostgresRemoteDevTarget,
} from "./node-pg-driver.ts";

// V0.10.11 W3. The driver refused every non-loopback host outright, which made
// an isolated development project unreachable. It now accepts exactly one
// non-loopback target, and only when the caller declared that host, port and
// database in advance. Everything else is refused exactly as before, so a typo,
// a stale environment variable or an undeclared host cannot open a path to a
// database nobody named.

const REMOTE: NodePostgresRemoteDevTarget = Object.freeze({
  host: "pooler.dev.invalid",
  port: 5432,
  database: "tivdoc_v09_devremote01",
  project_ref: "abcdefghijklmnopqrst",
});

const remoteUrl = (overrides: Partial<{ host: string; port: number; database: string; query: string }> = {}) => {
  const host = overrides.host ?? REMOTE.host;
  const port = overrides.port ?? REMOTE.port;
  const database = overrides.database ?? REMOTE.database;
  const query = overrides.query ?? "?sslmode=no-verify";
  return `postgresql://tivdoc_web_runtime.abcdefghijklmnopqrst:secret@${host}:${port}/${database}${query}`;
};

const loopbackUrl = "postgresql://tivdoc_web_runtime:secret@127.0.0.1:5432/tivdoc_v09_local0001";

describe("V0.10.11 declared remote development target", () => {
  it("still refuses a non-loopback host when nothing was declared", () => {
    // With no declaration the sslmode parameter is refused before the host is
    // even considered, so both forms are checked.
    expect(() => deriveNodePostgresTargetDescriptor(remoteUrl())).toThrow(/POSTGRES_TARGET_/u);
    expect(() => deriveNodePostgresTargetDescriptor(remoteUrl({ query: "" })))
      .toThrow("POSTGRES_TARGET_NOT_LOOPBACK");
    expect(() => deriveNodePostgresTargetDescriptor(remoteUrl({ query: "" }), null))
      .toThrow("POSTGRES_TARGET_NOT_LOOPBACK");
  });

  it("accepts the declared target and marks it allowlisted, never loopback-validated", () => {
    const target = deriveNodePostgresTargetDescriptor(remoteUrl(), REMOTE);
    expect(target.validation).toBe("REMOTE_DEV_ALLOWLISTED");
    expect(target.host).toBe(REMOTE.host);
    expect(target.port).toBe(REMOTE.port);
    expect(target.database).toBe(REMOTE.database);
    expect(target.disposable).toBe(true);
    expect(target.target_id).toContain(REMOTE.project_ref);
  });

  it("refuses a host, port or database that differs from the declaration", () => {
    for (const url of [
      remoteUrl({ host: "other.dev.invalid" }),
      remoteUrl({ port: 6543 }),
      remoteUrl({ database: "tivdoc_v09_somethingelse" }),
    ]) {
      expect(() => deriveNodePostgresTargetDescriptor(url, REMOTE), url).toThrow("POSTGRES_TARGET_NOT_LOOPBACK");
    }
  });

  it("refuses a declaration with no project ref", () => {
    expect(() => deriveNodePostgresTargetDescriptor(remoteUrl(), { ...REMOTE, project_ref: "" }))
      .toThrow("POSTGRES_TARGET_NOT_LOOPBACK");
  });

  it("keeps the disposable database rule for remote targets", () => {
    const database = "production_records";
    expect(() => deriveNodePostgresTargetDescriptor(
      remoteUrl({ database }), { ...REMOTE, database },
    )).toThrow("POSTGRES_TARGET_NOT_DISPOSABLE");
  });

  it("allows only an sslmode query parameter, and only on a declared target", () => {
    expect(deriveNodePostgresTargetDescriptor(remoteUrl({ query: "?sslmode=require" }), REMOTE).database)
      .toBe(REMOTE.database);
    expect(() => deriveNodePostgresTargetDescriptor(remoteUrl({ query: "?sslmode=allow" }), REMOTE))
      .toThrow("POSTGRES_TARGET_REQUIRED");
    expect(() => deriveNodePostgresTargetDescriptor(remoteUrl({ query: "?options=-c%20search_path%3Dx" }), REMOTE))
      .toThrow("POSTGRES_TARGET_REQUIRED");
    expect(() => deriveNodePostgresTargetDescriptor(`${loopbackUrl}?sslmode=require`, REMOTE))
      .toThrow("POSTGRES_TARGET_REQUIRED");
  });

  it("leaves loopback validation untouched", () => {
    const target = deriveNodePostgresTargetDescriptor(loopbackUrl);
    expect(target.validation).toBe("LOOPBACK_DISPOSABLE_VALIDATED");
    expect(target.host).toBe("127.0.0.1");
  });

  it("carries the declaration into the validated configuration", () => {
    const config = validateNodePostgresConnection({ connection_url: remoteUrl(), remote_dev_target: REMOTE });
    expect(config.remote_dev_target).toEqual(REMOTE);
    expect(config.target.validation).toBe("REMOTE_DEV_ALLOWLISTED");
    expect(validateNodePostgresConnection({ connection_url: loopbackUrl }).remote_dev_target).toBeNull();
  });
});
