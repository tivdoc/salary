import { resolveProductSessionBoundary } from "@/server/product/auth/runtime";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { createPortalHttpHandler } from "@/server/product/routes/portal-http";
import { resolveCanonicalPortalService } from "@/server/product/routes/runtime";
import { productNotFound, refusedEntrypoint } from "@/server/product/routes/http-common";
import { guardStableHttpEntrypoint } from "@/server/platform/capabilities/stable-http-entrypoint";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{ params: Promise<Readonly<{ resource?: string[] }>> }>;

async function handle(request: Request, context: Context): Promise<Response> {
  try {
    await guardStableHttpEntrypoint("CEP-025", request);
  } catch (error) {
    return refusedEntrypoint(error);
  }
  const { resource = [] } = await context.params;
  const sessions = resolveProductSessionBoundary();
  if (!sessions) return productNotFound("CAPABILITY_BLOCKED");
  return createPortalHttpHandler({
    enabled: readStableProductRouteFlags().portalApi,
    service: resolveCanonicalPortalService(),
    sessions,
  }).handle(request, resource);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}
