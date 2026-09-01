import "../routes/server-boundary.ts";

import { startCanonicalPostgresComposition } from "../../platform/composition/canonical-postgres.ts";
import { NodePostgresConnectionFactory } from "../../platform/persistence/postgres/runtime/node-pg-driver.ts";
import { LocalRuntimePrivateBlobProvider } from "../../platform/storage/local-runtime/private-blob-provider.ts";
import {
  createDurableRuntimeProductRegistrar,
  createDurableRuntimeWorkerContext,
} from "../durable-postgres/runtime-product-lane.ts";
import type { FreshWorkerChildRuntime } from "./fresh-child-launcher.ts";

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u;
const BUILD_SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SENTINEL = "TIVDOC_FRESH_WORKER_V0102" as const;

export type DurableWorkerRuntimeConfiguration = Readonly<{
  actor_id: string;
  tenant_id: string;
  session_id: string;
  token_id: string;
  rotation_counter: number;
  build_identity_sha: string;
  postgres_url: string;
  private_storage_root: string;
}>;

export function readDurableWorkerRuntimeConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DurableWorkerRuntimeConfiguration {
  if (environment.NODE_ENV !== "development"
      || environment.TIVDOC_WORKER_RUNTIME_SENTINEL !== SENTINEL) {
    throw new Error("DURABLE_WORKER_RUNTIME_DISABLED");
  }
  const actorId = opaque(environment.TIVDOC_WORKER_ACTOR_ID);
  const tenantId = opaque(environment.TIVDOC_WORKER_TENANT_ID);
  const sessionId = opaque(environment.TIVDOC_WORKER_SESSION_ID);
  const tokenId = opaque(environment.TIVDOC_WORKER_TOKEN_ID);
  const rotationCounter = exactCounter(environment.TIVDOC_WORKER_ROTATION_COUNTER);
  const buildIdentitySha = environment.TIVDOC_WORKER_BUILD_IDENTITY_SHA;
  const postgresUrl = environment.TIVDOC_WORKER_POSTGRES_URL;
  const privateStorageRoot = environment.TIVDOC_WORKER_PRIVATE_STORAGE_ROOT;
  if (!buildIdentitySha || !BUILD_SHA.test(buildIdentitySha)
      || !postgresUrl || postgresUrl.length > 4_096 || /[\r\n\0]/u.test(postgresUrl)
      || !privateStorageRoot || privateStorageRoot.length > 4_096 || /[\r\n\0]/u.test(privateStorageRoot)) {
    throw new Error("DURABLE_WORKER_CONFIGURATION_INVALID");
  }
  return Object.freeze({
    actor_id: actorId,
    tenant_id: tenantId,
    session_id: sessionId,
    token_id: tokenId,
    rotation_counter: rotationCounter,
    build_identity_sha: buildIdentitySha,
    postgres_url: postgresUrl,
    private_storage_root: privateStorageRoot,
  });
}

/** Constructs exactly one fresh worker runtime from worker-scoped configuration. */
export async function createDurableFreshWorkerChildRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<FreshWorkerChildRuntime> {
  const config = readDurableWorkerRuntimeConfiguration(environment);
  const factory = NodePostgresConnectionFactory.fromConnectionUrl({
    connection_url: config.postgres_url,
    max_connections: 1,
    connection_timeout_ms: 5_000,
    application_name: "tivdoc-v0102-fresh-worker",
  });
  try {
    const postgres = await startCanonicalPostgresComposition({
      mode: "isolated_postgres",
      execution_boundary: "non_test",
      target: factory.target,
      build_identity_sha: config.build_identity_sha,
    }, {
      runtime_connection_factories: { worker: factory },
      intake_factory: () => Object.freeze({}),
      analysis_factory: () => Object.freeze({}),
    });
    if (postgres.mode !== "isolated_postgres") {
      throw new Error("DURABLE_WORKER_POSTGRES_REQUIRED");
    }
    const storage = new LocalRuntimePrivateBlobProvider({
      root: config.private_storage_root,
      runtime_class: "ignored_local_private_filesystem",
      publicly_addressable: false,
      managed_platform_verified: false,
    });
    const context = createDurableRuntimeWorkerContext({
      postgres,
      identity: Object.freeze({
        actor_id: config.actor_id,
        tenant_id: config.tenant_id,
        session_id: config.session_id,
        token_id: config.token_id,
        rotation_counter: config.rotation_counter,
        reviewer_organization_id: null,
      }),
    });
    const worker = createDurableRuntimeProductRegistrar({ context, storage });
    return Object.freeze({
      worker,
      async close() {
        await factory.close();
      },
    });
  } catch (error) {
    await factory.close().catch(() => undefined);
    throw error;
  }
}

function opaque(value: string | undefined): string {
  if (!value || !OPAQUE.test(value)) throw new Error("DURABLE_WORKER_CONFIGURATION_INVALID");
  return value;
}

function exactCounter(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9][0-9]{0,8})$/u.test(value)) {
    throw new Error("DURABLE_WORKER_CONFIGURATION_INVALID");
  }
  const counter = Number(value);
  if (!Number.isSafeInteger(counter)) throw new Error("DURABLE_WORKER_CONFIGURATION_INVALID");
  return counter;
}
