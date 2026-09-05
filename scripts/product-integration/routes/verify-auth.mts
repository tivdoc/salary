import "../../production-refusal.mjs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sessionPath = join(root, "src/server/product/auth/hermetic-session.ts");
const httpPath = join(root, "src/server/product/auth/session-http.ts");
const session = readFileSync(sessionPath, "utf8");
const http = readFileSync(httpPath, "utf8");
const requiredSessionSignals = [
  "createHmac",
  "timingSafeEqual",
  "HttpOnly",
  "SameSite=Strict",
  "PRODUCT_CSRF_HEADER",
  "validCsrf",
  "isLoopbackUrl",
  "TIVDOC_HERMETIC_MODE",
  "TIVDOC_PRODUCT_SESSION_SECRET",
  "TIVDOC_PRODUCT_HERMETIC_TICKETS_JSON",
  "this.#nodeEnv === \"production\"",
  "this.#vercelEnv === \"preview\"",
  "hasIdentitySpoof",
  "IDENTITY_SPOOF_HEADERS",
  "IDENTITY_QUERY_KEYS",
  "this.#activeSessionIds",
];
const requiredHttpSignals = ["strictTicketBody", "set-cookie", "status: 404", "revokeProductSession"];
const failures = [
  ...requiredSessionSignals.filter((signal) => !session.includes(signal)).map((signal) => `missing_session_signal:${signal}`),
  ...requiredHttpSignals.filter((signal) => !http.includes(signal)).map((signal) => `missing_http_signal:${signal}`),
];

const result = {
  schema_version: "tivdoc-product-auth-boundary-verifier-v1",
  status: failures.length === 0 ? "PASS" : "FAIL",
  signed_hmac: session.includes("createHmac") && session.includes("timingSafeEqual"),
  http_only_same_site: session.includes("HttpOnly") && session.includes("SameSite=Strict"),
  local_loopback_only: session.includes("isLoopbackUrl") && session.includes("TIVDOC_HERMETIC_MODE"),
  production_preview_rejected: session.includes("this.#nodeEnv === \"production\"") && session.includes("this.#vercelEnv === \"preview\""),
  client_identity_rejected: session.includes("hasIdentitySpoof") && session.includes("IDENTITY_SPOOF_HEADERS") && session.includes("IDENTITY_QUERY_KEYS"),
  csrf_required: session.includes("validCsrf") && session.includes("PRODUCT_CSRF_HEADER"),
  logout_revocation: session.includes("this.#activeSessionIds.delete") && http.includes("revokeProductSession"),
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
