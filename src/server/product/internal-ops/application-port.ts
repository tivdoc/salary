import "./server-boundary.ts";

import type { VerifiedActor } from "../../../engine/wave4/contracts.ts";
import type { InternalOpsCommandResult, OpsReadProjection } from "./contracts.ts";
import type { InternalOpsReadKind } from "./service.ts";

/** Stable route-facing operations contract; implementations are always async. */
export interface InternalOpsApplicationPort {
  read(actor: VerifiedActor, kind: InternalOpsReadKind, caseId: string | null): Promise<OpsReadProjection>;
  mutate(actor: VerifiedActor, request: unknown, correlationId: string): Promise<InternalOpsCommandResult>;
}
