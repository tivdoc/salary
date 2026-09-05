import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  assertStableEntrypointCapability,
  isCapabilityBlockedError,
  type EntrypointCapabilityDecision,
} from "./stable-entrypoint-runtime.ts";

/**
 * Defers pages and generated metadata until an actual request owns the guard.
 * L8-1: a page whose capability is BLOCKED is not found — the same answer the
 * flag-gated pages give — rather than a 500 with the reason in it.
 */
export async function guardStableAppEntrypoint(entrypointId: string): Promise<EntrypointCapabilityDecision> {
  await connection();
  try {
    return assertStableEntrypointCapability(entrypointId);
  } catch (error) {
    if (isCapabilityBlockedError(error)) notFound();
    throw error;
  }
}
