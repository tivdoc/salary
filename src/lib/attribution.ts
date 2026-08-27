"use client";

export type FirstTouchAttribution = {
  funnelId: string;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  fbclid: string | null;
  fbp: string | null;
  fbc: string | null;
  gaClientId: string | null;
  landingUrl: string;
  referrer: string | null;
  firstTouchAt: string;
};

const STORAGE_KEY = "tivdoc:first-touch:v1";
const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

function shortValue(value: string | null, maxLength = 200) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function cookieValue(name: string) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(value.slice(prefix.length));
    } catch {
      return null;
    }
  }
  return null;
}

export function gaClientIdFromCookie(cookie: string | null) {
  if (!cookie) return null;
  const match = cookie.match(/^(?:GA\d+\.\d+\.)?(\d+\.\d+)$/);
  return match?.[1] ?? null;
}

function safeLocation(raw: string) {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return "";
  }
}

function readStored(): FirstTouchAttribution | null {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<FirstTouchAttribution> | null;
    return stored?.funnelId && stored.firstTouchAt ? (stored as FirstTouchAttribution) : null;
  } catch {
    return null;
  }
}

export function ensureFirstTouch(): FirstTouchAttribution {
  const stored = readStored();
  const currentFbp = shortValue(cookieValue("_fbp"), 512);
  const currentFbc = shortValue(cookieValue("_fbc"), 512);
  const currentGaClientId = gaClientIdFromCookie(cookieValue("_ga"));
  if (stored) {
    const enriched = {
      ...stored,
      fbp: stored.fbp || currentFbp,
      fbc: stored.fbc || currentFbc,
      gaClientId: stored.gaClientId || currentGaClientId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(enriched));
    return enriched;
  }

  const url = new URL(window.location.href);
  const values = Object.fromEntries(
    ATTRIBUTION_KEYS.map((key) => [key, shortValue(url.searchParams.get(key))]),
  );
  const created: FirstTouchAttribution = {
    funnelId: crypto.randomUUID(),
    utmSource: values.utm_source,
    utmMedium: values.utm_medium,
    utmCampaign: values.utm_campaign,
    utmContent: values.utm_content,
    utmTerm: values.utm_term,
    fbclid: shortValue(url.searchParams.get("fbclid"), 512),
    fbp: currentFbp,
    fbc: currentFbc,
    gaClientId: currentGaClientId,
    landingUrl: safeLocation(window.location.href),
    referrer: document.referrer ? safeLocation(document.referrer) : null,
    firstTouchAt: new Date().toISOString(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(created));
  return created;
}

export function currentFirstTouch() {
  if (
    typeof window === "undefined"
    || typeof document === "undefined"
    || typeof localStorage === "undefined"
  ) {
    return null;
  }
  return ensureFirstTouch();
}

export function recordFunnelEvent(
  eventName: string,
  options: { stepNumber?: number; publicCaseId?: string } = {},
) {
  if (
    typeof window === "undefined"
    || typeof document === "undefined"
    || typeof localStorage === "undefined"
  ) {
    return;
  }
  const attribution = ensureFirstTouch();
  void fetch("/api/funnel/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      attribution,
      eventName,
      stepNumber: options.stepNumber,
      publicCaseId: options.publicCaseId,
    }),
    keepalive: true,
  }).catch(() => undefined);
}
