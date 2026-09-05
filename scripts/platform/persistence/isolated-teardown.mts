import "../../production-refusal.mjs";
import { authorizeIsolatedTeardown, createOwnershipMarker, ISOLATED_POSTGRES_ENV_KEYS } from "../../../src/server/platform/persistence/isolated-environment.ts";

const targetId = process.env[ISOLATED_POSTGRES_ENV_KEYS.target_id];
const ownershipToken = process.env[ISOLATED_POSTGRES_ENV_KEYS.ownership_token];
const expectedMarkerHash = process.env.TIVDOC_ISOLATED_POSTGRES_MARKER_SHA256;

let authorized = false;
if (targetId && ownershipToken && expectedMarkerHash) {
  try {
    const marker = createOwnershipMarker({ target_id: targetId, ownership_token: ownershipToken });
    authorized = marker.ownership_token_sha256 === expectedMarkerHash
      && authorizeIsolatedTeardown({ marker, target_id: targetId, ownership_token: ownershipToken });
  } catch {
    authorized = false;
  }
}

process.stdout.write(`${JSON.stringify({
  schema_version: "tivdoc-isolated-postgres-teardown-gate-v1",
  status: authorized ? "AUTHORIZED_BUT_NOT_EXECUTED" : "TEARDOWN_REJECTED",
  exact_marker_and_token_verified: authorized,
  resources_deleted: 0,
  external_connections: 0,
  reason: authorized
    ? "This repository command is a proof-only gate; an adapter-owned teardown implementation is still required."
    : "Exact Tivdoc target ID, ownership token and marker hash were not supplied or did not match.",
})}\n`);
