import { issueProductSession, revokeProductSession } from "@/server/product/auth/session-http";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    await guardStableHttpEntrypoint("CEP-021", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  return issueProductSession(request, "operations", readStableProductRouteFlags().operationsApi);
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    await guardStableHttpEntrypoint("CEP-021", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  return revokeProductSession(request, "operations", readStableProductRouteFlags().operationsApi);
}
