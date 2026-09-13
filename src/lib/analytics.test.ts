import { afterEach, describe, expect, it, vi } from "vitest";
import { trackEvent } from "./analytics";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trackEvent", () => {
  it("does not queue external events while measurement is closed", () => {
    const browserWindow: Record<string, unknown> = {};
    vi.stubGlobal("window", browserWindow);

    trackEvent("payment_returned", { source: "invoice4u" });

    expect(browserWindow.tivdocAnalyticsQueue).toBeUndefined();
  });

  it("does not send even when a legacy GA4 function exists", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });

    trackEvent("start_check");

    expect(gtag).not.toHaveBeenCalled();
  });
});
