import { describe, expect, it } from "vitest";

import {
  ANCILLARY_CONNECTION_KEYS,
  assertProductConnectionTargets,
  classifyConnectionHost,
  PRODUCT_CONNECTION_KEYS,
} from "./durable-local-config.ts";

// V0.10.13 §3.2. The repository carries eight database URL keys. The 404 this
// run inherited came from a loopback label the server chose for itself, so a
// key quietly defaulting to loopback while the rest point at a declared target
// is a live failure mode. Startup refuses that split rather than discovering it
// as a 422 later.

const REMOTE = Object.freeze({
  host: "pooler.dev.invalid", port: 5432,
  database: "tivdoc_v09_devremote01", project_ref: "abcdefghijklmnopqrst",
});

const url = (host: string, port = 5432) =>
  `postgresql://tivdoc_web_runtime:secret@${host}:${port}/tivdoc_v09_devremote01`;

function environment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  const base: Record<string, string | undefined> = {};
  for (const key of PRODUCT_CONNECTION_KEYS) base[key] = url(REMOTE.host);
  return Object.freeze({ ...base, ...overrides });
}

describe("V0.10.13 connection target assertion", () => {
  it("classifies by host class and never by value", () => {
    expect(classifyConnectionHost(url(REMOTE.host), REMOTE)).toBe("declared_target");
    expect(classifyConnectionHost(url("127.0.0.1"), REMOTE)).toBe("loopback");
    expect(classifyConnectionHost(url("localhost"), REMOTE)).toBe("loopback");
    expect(classifyConnectionHost(url("db.elsewhere.invalid"), REMOTE)).toBe("other");
    expect(classifyConnectionHost(undefined, REMOTE)).toBe("unset");
    expect(classifyConnectionHost("   ", REMOTE)).toBe("unset");
    expect(classifyConnectionHost("not a url", REMOTE)).toBe("unparseable");
  });

  it("treats the declared target's own port as part of its identity", () => {
    expect(classifyConnectionHost(url(REMOTE.host, 6543), REMOTE)).toBe("other");
  });

  it("accepts a consistent declared target and a consistent loopback deployment", () => {
    expect(assertProductConnectionTargets(environment(), REMOTE)[PRODUCT_CONNECTION_KEYS[0]])
      .toBe("declared_target");
    const loopback = Object.fromEntries(PRODUCT_CONNECTION_KEYS.map((key) => [key, url("127.0.0.1")]));
    expect(assertProductConnectionTargets(loopback, null)[PRODUCT_CONNECTION_KEYS[0]]).toBe("loopback");
  });

  it("refuses one key silently falling back to loopback", () => {
    expect(() => assertProductConnectionTargets(
      environment({ TIVDOC_WORKER_POSTGRES_URL: url("127.0.0.1") }), REMOTE,
    )).toThrow("DURABLE_LOCAL_PRODUCT_CONNECTION_TARGET_SPLIT");
  });

  it("refuses a missing, unparseable or foreign product key", () => {
    for (const [value, code] of [
      [undefined, "DURABLE_LOCAL_PRODUCT_CONNECTION_TARGET_INVALID"],
      ["not a url", "DURABLE_LOCAL_PRODUCT_CONNECTION_TARGET_INVALID"],
      [url("db.elsewhere.invalid"), "DURABLE_LOCAL_PRODUCT_CONNECTION_TARGET_INVALID"],
    ] as const) {
      expect(() => assertProductConnectionTargets(
        environment({ TIVDOC_OPERATIONS_POSTGRES_URL: value }), REMOTE,
      ), String(value)).toThrow(code);
    }
  });

  it("classifies the ancillary keys without enforcing them", () => {
    const classes = assertProductConnectionTargets(environment(), REMOTE);
    for (const key of ANCILLARY_CONNECTION_KEYS) expect(classes[key]).toBe("unset");
    expect(() => assertProductConnectionTargets(
      environment({ TIVDOC_LOCAL_MIGRATOR_URL: url("127.0.0.1") }), REMOTE,
    )).not.toThrow();
  });

  it("covers every database URL key the repository defines", () => {
    expect([...PRODUCT_CONNECTION_KEYS, ...ANCILLARY_CONNECTION_KEYS]).toHaveLength(8);
  });
});
