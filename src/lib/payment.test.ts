import { describe, expect, it } from "vitest";
import { invoice4uOrderIdForCase } from "./payment";

describe("Invoice4u payment identity", () => {
  it("binds the provider order to the public case identifier", () => {
    expect(invoice4uOrderIdForCase("case-123")).toBe("tivdoc-salary:case-123");
  });
});
