import "../../production-refusal.mjs";
import { randomBytes } from "node:crypto";

import { createOwnershipMarker } from "../../../src/server/platform/persistence/isolated-environment.ts";

const suffix = randomBytes(8).toString("hex");
const targetId = `tivdoc-isolated-${suffix}`;
const ownershipToken = randomBytes(32).toString("hex");
const marker = createOwnershipMarker({ target_id: targetId, ownership_token: ownershipToken });

process.stdout.write(`${JSON.stringify({
  schema_version: "tivdoc-isolated-postgres-bootstrap-plan-v1",
  status: "PLAN_ONLY_NO_RESOURCE_CREATED",
  target_id: targetId,
  database: targetId.replaceAll("-", "_"),
  marker,
  ownership_token_emitted_to_stdout: false,
  next_action: "A human-controlled local bootstrapper may create this randomized loopback database and store the generated ownership token outside logs. This command never creates, connects, logs in, links, pulls or installs.",
  resources_created: 0,
  external_connections: 0,
})}\n`);
