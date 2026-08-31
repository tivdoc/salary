import { runtimeHermeticSessionManager } from "@/server/product/auth/hermetic-session";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { createPortalHttpHandler } from "@/server/product/routes/portal-http";
import { resolveCanonicalPortalService } from "@/server/product/routes/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{ params: Promise<Readonly<{ resource?: string[] }>> }>;

async function handle(request: Request, context: Context): Promise<Response> {
  const { resource = [] } = await context.params;
  return createPortalHttpHandler({
    enabled: readStableProductRouteFlags().portalApi,
    service: resolveCanonicalPortalService(),
    sessions: runtimeHermeticSessionManager(),
  }).handle(request, resource);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}
