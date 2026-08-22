import { describe, expect, it } from "vitest";
import {
  buildMetaCapiPayload,
  metaEventId,
  resolveMetaCapiConfig,
} from "./meta-events";

describe("Meta CAPI payloads", () => {
  it("sends a Purchase with exactly 9.99 ILS and hashes matching fields", () => {
    const payload = buildMetaCapiPayload({
      eventName: "Purchase",
      eventId: metaEventId("Purchase", "payment-1"),
      eventTime: 1_787_400_000,
      eventSourceUrl: "https://tivdoc.com/check/received",
      customer: {
        email: " Person@Example.com ",
        phone: "052-123-4567",
        firstName: " ולדימיר ",
        clientIpAddress: "203.0.113.7",
        clientUserAgent: "Test Browser",
        fbp: "fb.1.1787400000.123456",
      },
      customData: { value: 9.99, currency: "ILS" },
    });

    expect(payload.custom_data).toEqual({ value: 9.99, currency: "ILS" });
    expect(payload.event_name).toBe("Purchase");
    expect(payload.event_id).toBe("tivdoc:Purchase:payment-1");
    expect(payload.user_data.em?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.user_data.ph?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.user_data.fn?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(payload)).not.toContain("Person@Example.com");
    expect(JSON.stringify(payload)).not.toContain("052-123-4567");
    expect(JSON.stringify(payload)).not.toContain("ולדימיר");
  });

  it("uses a separate Dataset ID when provided", () => {
    expect(
      resolveMetaCapiConfig({
        NEXT_PUBLIC_META_PIXEL_ID: "pixel-1",
        META_DATASET_ID: "dataset-1",
        META_CAPI_ACCESS_TOKEN: "secret",
      }),
    ).toMatchObject({ datasetId: "dataset-1" });
  });

  it("stays disabled without Meta environment variables", () => {
    expect(resolveMetaCapiConfig({})).toBeNull();
    expect(resolveMetaCapiConfig({ NEXT_PUBLIC_META_PIXEL_ID: "pixel-only" })).toBeNull();
    expect(resolveMetaCapiConfig({ META_CAPI_ACCESS_TOKEN: "token-only" })).toBeNull();
  });
});
