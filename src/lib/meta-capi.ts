import "server-only";
import {
  META_GRAPH_API_VERSION,
  buildMetaCapiPayload,
  resolveMetaCapiConfig,
  type MetaCapiEventInput,
} from "./meta-events";

export type MetaCapiDeliveryResult =
  | { status: "sent" }
  | { status: "disabled" }
  | { status: "failed"; code: string };

type Fetcher = typeof fetch;

export async function sendMetaCapiEvent(
  input: MetaCapiEventInput,
  fetcher: Fetcher = fetch,
): Promise<MetaCapiDeliveryResult> {
  const config = resolveMetaCapiConfig(process.env);
  if (!config) return { status: "disabled" };

  const body = {
    data: [buildMetaCapiPayload(input)],
    access_token: config.accessToken,
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
  };

  let response: Response;
  try {
    response = await fetcher(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(config.datasetId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      },
    );
  } catch {
    return { status: "failed", code: "network_error" };
  }

  if (!response.ok) return { status: "failed", code: `http_${response.status}` };

  try {
    const payload = (await response.json()) as Record<string, unknown>;
    return typeof payload.events_received === "number" && payload.events_received > 0
      ? { status: "sent" }
      : { status: "failed", code: "event_not_accepted" };
  } catch {
    return { status: "failed", code: "invalid_response" };
  }
}

function parseCookieHeader(header: string | null) {
  const values = new Map<string, string>();
  for (const item of header?.split(";") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    try {
      values.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookies supplied by the browser.
    }
  }
  return values;
}

function safeEventSourceUrl(request: Request, fallbackPath: string) {
  const fallbackBase = process.env.NEXT_PUBLIC_SITE_URL || "https://tivdoc.com";
  const fallbackUrl = new URL(fallbackPath, fallbackBase);
  const referer = request.headers.get("referer");
  if (!referer) return fallbackUrl.toString();

  try {
    const url = new URL(referer);
    return url.origin === fallbackUrl.origin ? url.toString() : fallbackUrl.toString();
  } catch {
    return fallbackUrl.toString();
  }
}

export function metaRequestContext(request: Request, fallbackPath: string) {
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    eventSourceUrl: safeEventSourceUrl(request, fallbackPath),
    clientIpAddress: forwardedFor || request.headers.get("x-real-ip"),
    clientUserAgent: request.headers.get("user-agent"),
    fbp: cookies.get("_fbp"),
    fbc: cookies.get("_fbc"),
  };
}
