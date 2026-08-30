import { describe, expect, it } from "vitest";
import { bytesSha256 } from "./canonical";
import { LocalObjectWriteSaga } from "./object-write-saga";

async function* chunks(bytes: Uint8Array) {
  yield bytes.slice(0, 2);
  yield bytes.slice(2);
}

describe("content-addressed object-write saga", () => {
  it("keeps reserved, staged and verified writes invisible until atomic finalization", async () => {
    const bytes = new TextEncoder().encode("synthetic-object");
    const saga = new LocalObjectWriteSaga();
    const reserved = saga.reserve({ tenant_id: "tenant:synthetic", case_id: "case:synthetic", expected_sha256: bytesSha256(bytes), expected_length: bytes.length, detected_mime: "application/octet-stream", retention_class: "case_record" });
    expect(reserved.visible).toBe(false);
    expect((await saga.stage(reserved.reservation_id, chunks(bytes))).visible).toBe(false);
    expect(saga.verify(reserved.reservation_id).visible).toBe(false);
    const finalized = saga.finalize(reserved.reservation_id);
    expect(finalized.visible).toBe(true);
    expect(saga.visibleObject(finalized.object_version_id!)?.bytes).toEqual(bytes);
  });

  it("leaves every injected failed stage invisible, including finalize rollback", async () => {
    const bytes = new TextEncoder().encode("synthetic-object");
    const expected = bytesSha256(bytes);
    const reserveFailure = new LocalObjectWriteSaga();
    expect(() => reserveFailure.reserve({ tenant_id: "t", case_id: "c", expected_sha256: expected, expected_length: bytes.length, detected_mime: "application/octet-stream", retention_class: "temporary" }, "after_reserve")).toThrowError(/INJECTED_FAILURE/);
    expect(reserveFailure.snapshot().records.every((record) => !record.visible)).toBe(true);

    const saga = new LocalObjectWriteSaga();
    const reserved = saga.reserve({ tenant_id: "t", case_id: "c", expected_sha256: expected, expected_length: bytes.length, detected_mime: "application/octet-stream", retention_class: "temporary" });
    await expect(saga.stage(reserved.reservation_id, chunks(bytes), "after_stage")).rejects.toThrowError(/INJECTED_FAILURE/);
    expect(saga.record(reserved.reservation_id)?.visible).toBe(false);
    expect(() => saga.verify(reserved.reservation_id, "after_verify")).toThrowError(/INJECTED_FAILURE/);
    expect(saga.record(reserved.reservation_id)?.visible).toBe(false);
    expect(() => saga.finalize(reserved.reservation_id, "after_finalize")).toThrowError(/INJECTED_FAILURE/);
    expect(saga.record(reserved.reservation_id)).toMatchObject({ state: "verified", visible: false });
  });

  it("rejects checksum mismatch without exposing bytes", async () => {
    const expected = new TextEncoder().encode("expected");
    const actual = new TextEncoder().encode("different");
    const saga = new LocalObjectWriteSaga();
    const reserved = saga.reserve({ tenant_id: "t", case_id: "c", expected_sha256: bytesSha256(expected), expected_length: actual.length, detected_mime: "application/octet-stream", retention_class: "temporary" });
    await saga.stage(reserved.reservation_id, chunks(actual));
    expect(() => saga.verify(reserved.reservation_id)).toThrowError(/checksum_or_length_mismatch/);
    expect(saga.snapshot().records.every((record) => !record.visible)).toBe(true);
  });
});
