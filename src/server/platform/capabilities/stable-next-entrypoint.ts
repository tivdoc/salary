import { connection } from "next/server";

import {
  assertStableEntrypointCapability,
  type EntrypointCapabilityDecision,
} from "./stable-entrypoint-runtime.ts";

/** Defers pages and generated metadata until an actual request owns the guard. */
export async function guardStableAppEntrypoint(entrypointId: string): Promise<EntrypointCapabilityDecision> {
  await connection();
  return assertStableEntrypointCapability(entrypointId);
}
