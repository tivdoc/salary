import { describe, expect, it } from "vitest";
import { enrichFirstTouch, gaClientIdFromCookie, type FirstTouchAttribution } from "./attribution";

describe("gaClientIdFromCookie", () => {
  it("extracts the stable GA client id", () => {
    expect(gaClientIdFromCookie("GA1.1.123456.789012")).toBe("123456.789012");
  });

  it("rejects malformed identifiers", () => {
    expect(gaClientIdFromCookie("customer@example.com")).toBeNull();
  });
});

describe("enrichFirstTouch", () => {
  it("never overwrites first-touch campaign fields on a returning visit", () => {
    const stored: FirstTouchAttribution = {
      funnelId: "9ed3aeeb-1dc5-478c-a072-088f5336ca1e",
      utmSource: "facebook",
      utmMedium: "paid_social",
      utmCampaign: "launch",
      utmContent: "creative-b",
      utmTerm: "broad",
      fbclid: "first-click",
      fbp: null,
      fbc: null,
      gaClientId: null,
      landingUrl: "https://tivdoc.com/",
      referrer: "https://facebook.com/",
      firstTouchAt: "2026-08-28T00:00:00.000Z",
    };

    const enriched = enrichFirstTouch(stored, {
      fbp: "fb.1.123.456",
      fbc: "fb.1.123.returning",
      gaClientId: "123.456",
    });

    expect(enriched).toMatchObject({
      utmSource: "facebook",
      utmMedium: "paid_social",
      utmCampaign: "launch",
      utmContent: "creative-b",
      utmTerm: "broad",
      fbclid: "first-click",
      landingUrl: "https://tivdoc.com/",
      firstTouchAt: "2026-08-28T00:00:00.000Z",
      fbp: "fb.1.123.456",
      fbc: "fb.1.123.returning",
      gaClientId: "123.456",
    });
  });
});
