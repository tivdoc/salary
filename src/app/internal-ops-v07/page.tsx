import { notFound } from "next/navigation";
import { InternalOpsConsole } from "@/components/internal-ops-v07/internal-ops-console";
import { resolveInternalOpsRuntime } from "@/server/product/internal-ops/runtime";

export const dynamic = "force-dynamic";

export default function InternalOpsPage() {
  const { flags } = resolveInternalOpsRuntime();
  if (!flags.TIVDOC_INTERNAL_OPS_UI_ENABLED) notFound();
  return <InternalOpsConsole apiEnabled={flags.TIVDOC_INTERNAL_OPS_API_ENABLED} />;
}
