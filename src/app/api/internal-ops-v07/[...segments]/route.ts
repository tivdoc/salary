import { createInternalOpsHttpAdapter } from "@/server/product/internal-ops/http";
import { resolveInternalOpsRuntime } from "@/server/product/internal-ops/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = Readonly<{ params: Promise<{ segments: string[] }> }>;

async function handle(request: Request, context: Context): Promise<Response> {
  const { segments } = await context.params;
  const adapter = createInternalOpsHttpAdapter(resolveInternalOpsRuntime());
  return adapter.handle(request, segments);
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return handle(request, context);
}
