import { readFile } from "node:fs/promises";

import {
  replayCanonicalCapabilityMatrix,
  type DurableCapabilityState,
} from "./capabilities.mts";

const connectionUrl = requiredEnvironment("TIVDOC_V091_REPLAY_CONNECTION_URL");
const buildIdentitySha = requiredEnvironment("TIVDOC_V091_BUILD_IDENTITY_SHA");
const durableStatePath = requiredEnvironment("TIVDOC_V091_DURABLE_STATE_PATH");
const durableState = JSON.parse(await readFile(durableStatePath, "utf8")) as DurableCapabilityState;

const replay = await replayCanonicalCapabilityMatrix({
  connection_url: connectionUrl,
  build_identity_sha: buildIdentitySha,
}, durableState);
if (!replay.replayed || replay.matrix.length !== 14 || replay.adapter_replay.status !== "PASS") {
  throw new Error("RESTART_REPLAY_INCOMPLETE");
}

process.stdout.write(`${JSON.stringify(Object.freeze({
  schema_version: "tivdoc-real-postgresql-fresh-process-replay-v0.9.1",
  proof_class: "REAL_POSTGRESQL_DYNAMIC_PROOF",
  fresh_node_process: true,
  capability_count: replay.matrix.length,
  adapter_replay: replay.adapter_replay,
  connection_attempts: replay.driver_metrics.connection_attempts,
  credentials_recorded: 0,
  status: "PASS",
}))}\n`);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RESTART_REPLAY_ENVIRONMENT_MISSING:${name}`);
  return value;
}
