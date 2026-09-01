import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConfiguredIdentityVerificationKeyResolver } from "./configured-verification-key.ts";

const ISSUER = "https://identity.test.invalid";
const KEY_ID = "key-00000001";
const START = 1_900_000_000;
const END = START + 3_600;
const rsa = generateKeyPairSync("rsa", { modulusLength: 2_048 });
const ed25519 = generateKeyPairSync("ed25519");

function pem(key = rsa.publicKey): string {
  return key.export({ format: "pem", type: "spki" }).toString();
}

describe("configured identity verification key", () => {
  it("resolves only the exact configured issuer, key id, and algorithm", async () => {
    const resolver = new ConfiguredIdentityVerificationKeyResolver({
      issuer: ISSUER,
      key_id: KEY_ID,
      algorithm: "RS256",
      public_key_spki_pem: pem(),
      not_before_epoch: START,
      expires_at_epoch: END,
    });

    await expect(resolver.resolve({ issuer: ISSUER, key_id: KEY_ID, algorithm: "RS256" }))
      .resolves.toMatchObject({ key_id: KEY_ID, algorithm: "RS256", status: "active" });
    await expect(resolver.resolve({ issuer: `${ISSUER}/other`, key_id: KEY_ID, algorithm: "RS256" }))
      .resolves.toBeNull();
    await expect(resolver.resolve({ issuer: ISSUER, key_id: "key-00000002", algorithm: "RS256" }))
      .resolves.toBeNull();
    await expect(resolver.resolve({ issuer: ISSUER, key_id: KEY_ID, algorithm: "EdDSA" }))
      .resolves.toBeNull();
  });

  it("rejects private, malformed, mismatched, and unbounded key configurations", () => {
    const base = {
      issuer: ISSUER,
      key_id: KEY_ID,
      algorithm: "RS256" as const,
      public_key_spki_pem: pem(),
      not_before_epoch: START,
      expires_at_epoch: END,
    };

    expect(() => new ConfiguredIdentityVerificationKeyResolver({ ...base, issuer: "http://identity.test.invalid" }))
      .toThrow("IDENTITY_CONFIG_ISSUER_INVALID");
    expect(() => new ConfiguredIdentityVerificationKeyResolver({ ...base, public_key_spki_pem: "not-a-key" }))
      .toThrow("IDENTITY_CONFIG_PUBLIC_KEY_INVALID");
    expect(() => new ConfiguredIdentityVerificationKeyResolver({ ...base, public_key_spki_pem: pem(ed25519.publicKey) }))
      .toThrow("IDENTITY_CONFIG_PUBLIC_KEY_ALGORITHM_MISMATCH");
    expect(() => new ConfiguredIdentityVerificationKeyResolver({ ...base, expires_at_epoch: START }))
      .toThrow("IDENTITY_CONFIG_KEY_WINDOW_INVALID");
  });
});
