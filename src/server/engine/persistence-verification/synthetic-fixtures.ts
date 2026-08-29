import type { SyntheticActor, SyntheticPersistenceRecord } from "./synthetic-store";

export const SYNTHETIC_ACTOR_ALPHA: SyntheticActor = {
  actor_id: "actor-alpha",
  tenant_id: "tenant-alpha",
  permitted_case_ids: ["case-alpha"],
};

export const SYNTHETIC_ACTOR_BETA: SyntheticActor = {
  actor_id: "actor-beta",
  tenant_id: "tenant-beta",
  permitted_case_ids: ["case-beta"],
};

export function syntheticRecord(
  kind: SyntheticPersistenceRecord["kind"],
  sequence: number,
  overrides: Partial<Omit<SyntheticPersistenceRecord, "version">> = {},
): Omit<SyntheticPersistenceRecord, "version"> {
  return {
    id: `${kind}-${sequence}`,
    kind,
    tenant_id: SYNTHETIC_ACTOR_ALPHA.tenant_id,
    case_id: SYNTHETIC_ACTOR_ALPHA.permitted_case_ids[0],
    idempotency_key: `${kind}.attempt-${sequence}`,
    payload: { synthetic: true, sequence },
    ...overrides,
  };
}
