import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackMetaBrowserEventOnce } from "./meta-browser";

const originalPixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
const originalWindow = globalThis.window;

afterEach(() => {
  if (originalPixelId === undefined) delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
  else process.env.NEXT_PUBLIC_META_PIXEL_ID = originalPixelId;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Meta browser delivery", () => {
  it("does not send or throw when the Pixel is unconfigured", () => {
    delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
    expect(
      trackMetaBrowserEventOnce({ eventName: "Lead", eventId: "tivdoc:Lead:case-1" }),
    ).toBe(false);
  });

  it("does not fire Purchase again after received is refreshed", () => {
    process.env.NEXT_PUBLIC_META_PIXEL_ID = "pixel-1";
    const storage = new Map<string, string>();
    const fbq = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        fbq,
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    });
    const event = {
      eventName: "Purchase" as const,
      eventId: "tivdoc:Purchase:payment-1",
      customData: { value: 9.99, currency: "ILS" },
    };

    trackMetaBrowserEventOnce(event);
    trackMetaBrowserEventOnce(event);

    expect(fbq).toHaveBeenCalledTimes(1);
    expect(fbq).toHaveBeenCalledWith(
      "track",
      "Purchase",
      { value: 9.99, currency: "ILS" },
      { eventID: "tivdoc:Purchase:payment-1" },
    );
  });

  it("keeps the CAPI token outside every client Meta module", () => {
    const clientFiles = ["meta-browser.ts", "../components/meta-pixel-provider.tsx"];
    for (const relativePath of clientFiles) {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      expect(readFileSync(path, "utf8")).not.toContain("META_CAPI_ACCESS_TOKEN");
    }
  });
});
