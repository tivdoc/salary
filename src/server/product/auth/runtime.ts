import "./server-boundary.ts";

import type { ProductAudience, IssuedProductSession, VerifiedProductSession } from "./hermetic-session.ts";

export type ProductSessionProofClass = "DURABLE_CRYPTOGRAPHIC_SESSION" | "HERMETIC_LOOPBACK_TEST_SESSION";

/** One identity/session boundary for pages, APIs, logout and test-only login. */
export interface ProductSessionBoundary {
  readonly proof_class: ProductSessionProofClass;
  verify(request: Request, audience: ProductAudience, requireCsrf: boolean): Promise<VerifiedProductSession | null> | VerifiedProductSession | null;
  issue?(request: Request, audience: ProductAudience, ticket: string): Promise<IssuedProductSession | null> | IssuedProductSession | null;
  revoke?(request: Request, audience: ProductAudience): Promise<string | null> | string | null;
}

type ProductSessionRuntimeGlobal = typeof globalThis & {
  __tivdocProductSessionBoundary?: ProductSessionBoundary;
};

function runtimeGlobal(): ProductSessionRuntimeGlobal {
  return globalThis as ProductSessionRuntimeGlobal;
}

export function installProductSessionBoundary(boundary: ProductSessionBoundary): void {
  if (runtimeGlobal().__tivdocProductSessionBoundary) throw new Error("PRODUCT_SESSION_BOUNDARY_ALREADY_INSTALLED");
  runtimeGlobal().__tivdocProductSessionBoundary = Object.freeze(boundary);
}

export function resolveProductSessionBoundary(): ProductSessionBoundary | null {
  return runtimeGlobal().__tivdocProductSessionBoundary ?? null;
}

export function resetProductSessionBoundaryForTests(): void {
  if (Reflect.get(process.env, "NODE_ENV") !== "test") throw new Error("PRODUCT_SESSION_BOUNDARY_RESET_FORBIDDEN");
  delete runtimeGlobal().__tivdocProductSessionBoundary;
}
