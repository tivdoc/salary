import { describe, expect, it } from "vitest";

import {
  assertEnum,
  rowJson,
  rowNullableString,
  rowSafeInteger,
  rowSha256,
  rowString,
} from "./codec.ts";

describe("strict PostgreSQL runtime row codecs", () => {
  it.each([
    () => rowJson({ payload: "{" }, "payload"),
    () => rowSafeInteger({ revision: "9007199254740992" }, "revision"),
    () => assertEnum("unknown", ["queued", "running"] as const),
    () => rowString({ tenant_id: null }, "tenant_id"),
    () => rowSha256({ payload_sha256: "not-a-hash" }, "payload_sha256"),
  ])("rejects malformed, overflow, wrong-enum, missing-owner and corrupt-hash rows", (decode) => {
    expect(decode).toThrowError("POSTGRES_ROW_MALFORMED");
  });

  it("distinguishes an allowed database null from an unexpected null", () => {
    expect(rowNullableString({ case_id: null }, "case_id")).toBeNull();
    expect(() => rowString({ case_id: null }, "case_id")).toThrowError("POSTGRES_ROW_MALFORMED");
  });
});
