import { afterEach, describe, expect, it, vi } from "vitest";
import { trackEvent } from "./analytics";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackEvent", () => {
  it("queues events until GA4 is initialized", () => {
    const browserWindow: Record<string, unknown> = {};
    vi.stubGlobal("window", browserWindow);

    trackEvent("payment_returned", { source: "invoice4u" });

    expect(browserWindow.tivdocAnalyticsQueue).toEqual([
      { eventName: "payment_returned", params: { source: "invoice4u" } },
    ]);
  });

  it("sends events immediately after GA4 is initialized", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });

    trackEvent("start_check");

    expect(gtag).toHaveBeenCalledWith("event", "start_check", undefined);
  });
});
