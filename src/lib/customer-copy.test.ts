import { describe, expect, it } from "vitest";
import { CUSTOMER_ERROR_COPY, customerErrorMessage } from "./customer-copy.ts";

// UX Run 1 / U8: no component renders a raw error.
describe("customer error copy", () => {
  it("maps a known code to Hebrew copy and ignores whatever else came with it", () => {
    expect(customerErrorMessage({ code: "access_code_locked", error: "TypeError: boom" })).toBe(CUSTOMER_ERROR_COPY.access_code_locked);
  });

  it("passes the product's own Hebrew message through, and never a technical string", () => {
    expect(customerErrorMessage({ error: "לא נמצא תיק בדיקה בדפדפן הזה" }, "unknown")).toBe("לא נמצא תיק בדיקה בדפדפן הזה");
    expect(customerErrorMessage({ error: "StorageApiError: new row violates row-level security policy" }, "upload_transfer_failed")).toBe(CUSTOMER_ERROR_COPY.upload_transfer_failed);
    expect(customerErrorMessage({ error: "Failed to fetch" }, "network_failed")).toBe(CUSTOMER_ERROR_COPY.network_failed);
    expect(customerErrorMessage({ error: "שגיאה: token undefined" }, "unknown")).toBe(CUSTOMER_ERROR_COPY.unknown);
    expect(customerErrorMessage({ error: null }, "case_status_unavailable")).toBe(CUSTOMER_ERROR_COPY.case_status_unavailable);
  });

  it("every code has Hebrew copy without a technical word in it", () => {
    for (const [code, copy] of Object.entries(CUSTOMER_ERROR_COPY)) {
      expect(/[֐-׿]/u.test(copy), code).toBe(true);
      expect(/error|exception|undefined|null|token/iu.test(copy), code).toBe(false);
    }
  });
});
