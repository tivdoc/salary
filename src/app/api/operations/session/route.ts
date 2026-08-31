import { issueProductSession, revokeProductSession } from "@/server/product/auth/session-http";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return issueProductSession(request, "operations", readStableProductRouteFlags().operationsApi);
}

export async function DELETE(request: Request): Promise<Response> {
  return revokeProductSession(request, "operations", readStableProductRouteFlags().operationsApi);
}
