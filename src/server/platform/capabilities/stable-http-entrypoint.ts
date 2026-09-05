import {
  assertRequestWithinSystemLimits,
  type SystemLimits,
} from "./system-capabilities.ts";
import {
  resolveStableEntrypointRuntime,
  type EntrypointCapabilityDecision,
} from "./stable-entrypoint-runtime.ts";

export type StableHttpRequestDimensions = Readonly<{
  body_kind?: "json" | "upload";
  page_count?: number;
  field_count?: number;
  batch_size?: number;
  report_bytes?: number;
}>;

/**
 * Request-time guard for App Router Route Handlers. The capability decision is
 * evaluated before the body is read, then a clone is drained with a hard byte
 * ceiling so chunked requests cannot bypass Content-Length checks.
 */
export async function guardStableHttpEntrypoint(
  entrypointId: string,
  request: Request,
  dimensions: StableHttpRequestDimensions = {},
): Promise<EntrypointCapabilityDecision> {
  const runtime = resolveStableEntrypointRuntime();
  const decision = runtime.assert(entrypointId);
  // L9-4 / D3: the product half is served as `main` serves it — the route's own code decides, nothing is read here.
  if (runtime.servesAsMain(entrypointId)) return decision;
  const contentLength = parseContentLength(request.headers.get("content-length"));
  assertRequestWithinSystemLimits({
    limits: runtime.limits,
    content_length: contentLength,
    body_bytes: 0,
    ...dimensions,
  });
  const bodyBytes = await boundedBodyBytes(request, runtime.limits, dimensions.body_kind ?? "json");
  assertRequestWithinSystemLimits({
    limits: runtime.limits,
    content_length: contentLength,
    body_bytes: bodyBytes,
    ...dimensions,
  });
  return decision;
}

function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(raw)) throw new Error("CAPABILITY_CONTENT_LENGTH_INVALID");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("CAPABILITY_CONTENT_LENGTH_INVALID");
  return value;
}

async function boundedBodyBytes(
  request: Request,
  limits: SystemLimits,
  bodyKind: "json" | "upload",
): Promise<number> {
  if (request.body === null) return 0;
  const maximum = bodyKind === "upload" ? limits.maximum_upload_bytes : limits.maximum_json_body_bytes;
  let clone: Request;
  try {
    clone = request.clone();
  } catch {
    throw new Error("CAPABILITY_REQUEST_BODY_ALREADY_USED");
  }
  const reader = clone.body?.getReader();
  if (!reader) return 0;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
      if (!Number.isSafeInteger(total) || total > maximum) throw new Error("CAPABILITY_BODY_LIMIT");
    }
  } catch (error) {
    // A cloned body is a tee; awaiting cancellation can wait on the untouched
    // original branch. Signal cancellation without turning rejection into a hang.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
