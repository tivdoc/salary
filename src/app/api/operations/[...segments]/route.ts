import { resolveProductSessionBoundary } from "@/server/product/auth/runtime";
import { readStableProductRouteFlags } from "@/server/product/routes/flags";
import { createOperationsHttpHandler } from "@/server/product/routes/operations-http";
import { resolveCanonicalOperationsService } from "@/server/product/routes/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{ params: Promise<Readonly<{ segments: string[] }>> }>;

async function handle(request: Request, context: Context): Promise<Response> {
  const { segments } = await context.params;
  const sessions = resolveProductSessionBoundary();
  if (!sessions) return new Response(null, { status: 404 });
  return createOperationsHttpHandler({
    enabled: readStableProductRouteFlags().operationsApi,
    service: resolveCanonicalOperationsService(),
    sessions,
  }).handle(request, segments);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}
