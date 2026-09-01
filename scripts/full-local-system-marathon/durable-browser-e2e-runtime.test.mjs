import assert from "node:assert/strict";
import { constants, createPublicKey, verify } from "node:crypto";
import test from "node:test";

import {
  DURABLE_BROWSER_CSRF_COOKIE,
  DURABLE_BROWSER_IDENTITY_COOKIE,
  durableBrowserFixtureIds,
  durableBrowserJwtClaims,
  durableBrowserRuntimeEnvironment,
  durableBrowserStorageState,
  generateDurableBrowserKeyMaterial,
  signDurableBrowserJwt,
} from "./durable-browser-e2e-runtime.mts";

const RUN_ID = "abcdef123456";

test("builds distinct synthetic identities and a valid exact RS256 token", () => {
  const fixture = durableBrowserFixtureIds(RUN_ID);
  assert.notEqual(fixture.legal_reviewer.actor_id, fixture.report_approver.actor_id);
  assert.notEqual(
    fixture.legal_reviewer.reviewer_organization_id,
    fixture.report_approver.reviewer_organization_id,
  );
  assert.equal(fixture.owner.role, "customer_owner");
  assert.equal(fixture.worker.role, "scoped_background_worker");
  assert.match(fixture.case_id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/u);

  const key = generateDurableBrowserKeyMaterial(RUN_ID);
  const claims = durableBrowserJwtClaims({
    fixture: fixture.legal_reviewer,
    tenant_id: fixture.tenant_id,
    case_id: fixture.case_id,
    issuer: "https://identity.synthetic.invalid",
    issued_at_epoch: 2_000_000_000,
    expires_at_epoch: 2_000_001_800,
  });
  const compact = signDurableBrowserJwt(claims, key.key_id, key.private_key);
  const [header, payload, signature] = compact.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString("utf8")).alg, "RS256");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), claims);
  assert.equal(claims.rotation, 1);
  assert.equal(verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`, "ascii"),
    {
      key: createPublicKey(key.public_key_spki_pem),
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(signature, "base64url"),
  ), true);
});

test("uses only secure host identity and strict CSRF cookies", () => {
  const state = durableBrowserStorageState({
    compact_jwt: `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`,
    csrf_token: "d".repeat(43),
    expires_at_epoch: 2_000_001_800,
  });
  const identity = state.cookies.find((cookie) => cookie.name === DURABLE_BROWSER_IDENTITY_COOKIE);
  const csrf = state.cookies.find((cookie) => cookie.name === DURABLE_BROWSER_CSRF_COOKIE);
  assert.deepEqual(identity, {
    name: DURABLE_BROWSER_IDENTITY_COOKIE,
    value: `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`,
    domain: "127.0.0.1",
    path: "/",
    expires: 2_000_001_800,
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });
  assert.equal(csrf?.secure, true);
  assert.equal(csrf?.httpOnly, false);
  assert.equal(csrf?.sameSite, "Strict");
});

test("pins the strict durable local flags and four least-privilege URLs", () => {
  const fixture = durableBrowserFixtureIds(RUN_ID);
  const url = (role) => `postgresql://${role}:synthetic-secret@127.0.0.1:41000/tivdoc_v09_durable_abcdef123456`;
  const environment = durableBrowserRuntimeEnvironment({
    system_environment: { SYSTEMROOT: "C:\\Windows", TEMP: "C:\\Temp" },
    build_identity_sha: "a".repeat(40),
    allowed_origin: "https://127.0.0.1:42000",
    issuer: "https://identity.synthetic.invalid",
    key_id: "synthetic-key-abcdef123456",
    public_key_spki_pem: "synthetic-public-key",
    key_not_before_epoch: 2_000_000_000,
    key_expires_at_epoch: 2_000_003_600,
    identity_postgres_url: url("tivdoc_identity_runtime"),
    web_postgres_url: url("tivdoc_web_runtime"),
    operations_postgres_url: url("tivdoc_operations_runtime"),
    worker_postgres_url: url("tivdoc_worker_runtime"),
    private_storage_root: "C:\\Temp\\tivdoc-private-runtime-test",
    download_grant_hmac_key_base64url: "e".repeat(43),
    worker: fixture.worker,
    tenant_id: fixture.tenant_id,
  });
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED, "1");
  assert.equal(environment.TIVDOC_CUSTOMER_PROCESSING_ENABLED, "0");
  assert.equal(environment.TIVDOC_CUSTOMER_SHADOW_AUTHORIZED, "0");
  assert.equal(environment.TIVDOC_PRODUCTION_DELIVERY_ENABLED, "0");
  assert.equal(environment.TIVDOC_OPENAI_LIVE_TESTS, "0");
  assert.equal(environment.TIVDOC_PRODUCT_BROWSER_RUNTIME_ENABLED, "0");
  assert.equal(environment.TIVDOC_WORKER_ROTATION_COUNTER, "1");
});
