import { describe, expect, it } from "vitest";
import { gaClientIdFromCookie } from "./attribution";

describe("gaClientIdFromCookie", () => {
  it("extracts the stable GA client id", () => {
    expect(gaClientIdFromCookie("GA1.1.123456.789012")).toBe("123456.789012");
  });

  it("rejects malformed identifiers", () => {
    expect(gaClientIdFromCookie("customer@example.com")).toBeNull();
  });
});
