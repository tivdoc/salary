import { issueProductSession, revokeProductSession } from "@/server/product/auth/session-http";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  await guardStableHttpEntrypoint("CEP-026", request);
  return issueProductSession(request, "portal", readStableProductRouteFlags().portalApi);
}

export async function DELETE(request: Request): Promise<Response> {
  await guardStableHttpEntrypoint("CEP-026", request);
  return revokeProductSession(request, "portal", readStableProductRouteFlags().portalApi);
}
