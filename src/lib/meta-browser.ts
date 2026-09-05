"use client";

import type { MetaConversionEventName, MetaEventDescriptor } from "./meta-events";
import { initialCheckPriceNumber } from "./product-offer";

type MetaBrowserEventName = MetaConversionEventName | "PageView" | "ViewContent";
type MetaCustomData = Record<string, string | number>;
type MetaPixelArguments = [
  command: "track",
  eventName: MetaBrowserEventName,
  customData?: MetaCustomData,
  options?: { eventID: string },
];

declare global {
  interface Window {
    fbq?: (...args: MetaPixelArguments | ["init", string]) => void;
    tivdocMetaPixelQueue?: MetaPixelArguments[];
  }
}

function pixelConfigured() {
  return Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID);
}

export function trackMetaBrowserEvent(
  eventName: MetaBrowserEventName,
  customData?: MetaCustomData,
  eventId?: string,
) {
  if (typeof window === "undefined" || !pixelConfigured()) return false;

  const args: MetaPixelArguments = eventId
    ? ["track", eventName, customData ?? {}, { eventID: eventId }]
    : ["track", eventName, customData ?? {}];
  if (window.fbq) {
    window.fbq(...args);
  } else {
    window.tivdocMetaPixelQueue = window.tivdocMetaPixelQueue || [];
    window.tivdocMetaPixelQueue.push(args);
  }
  return true;
}

export function trackMetaBrowserEventOnce(descriptor: MetaEventDescriptor) {
  if (typeof window === "undefined" || !pixelConfigured()) return false;
  const key = `tivdoc:meta:${descriptor.eventName}:${descriptor.eventId}`;
  try {
    if (window.localStorage.getItem(key) === "1") return false;
  } catch {
    // Browser privacy settings can disable storage; Meta's event_id still deduplicates.
  }

  const tracked = trackMetaBrowserEvent(
    descriptor.eventName,
    descriptor.customData,
    descriptor.eventId,
  );
  if (tracked) {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // The shared event_id remains the cross-channel deduplication mechanism.
    }
  }
  return tracked;
}

export function trackMetaViewContentOnce() {
  if (typeof window === "undefined" || !pixelConfigured()) return false;
  const key = "tivdoc:meta:ViewContent:start-check";
  try {
    if (window.sessionStorage.getItem(key) === "1") return false;
  } catch {
    // Continue without the optional browser-side guard.
  }
  const tracked = trackMetaBrowserEvent("ViewContent");
  if (tracked) {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      // No server event is paired with ViewContent, so this is only a local guard.
    }
  }
  return tracked;
}

export function metaEventDescriptor(value: unknown): MetaEventDescriptor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MetaEventDescriptor>;
  if (
    !["Lead", "InitiateCheckout", "Purchase"].includes(candidate.eventName ?? "") ||
    typeof candidate.eventId !== "string" ||
    !/^tivdoc:[A-Za-z]+:[A-Za-z0-9_.:-]{1,80}$/.test(candidate.eventId)
  ) {
    return null;
  }
  if (
    candidate.eventName === "Purchase" &&
    (candidate.customData?.value !== initialCheckPriceNumber() || candidate.customData.currency !== "ILS")
  ) {
    return null;
  }
  return candidate as MetaEventDescriptor;
}
