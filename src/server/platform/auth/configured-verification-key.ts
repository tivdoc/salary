import "./server-boundary.ts";

import { createPublicKey } from "node:crypto";

import type {
  IdentityJwtAlgorithm,
  IdentityVerificationKey,
  IdentityVerificationKeyResolver,
} from "./identity-verification.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const MAX_PUBLIC_KEY_BYTES = 16_384;

export type ConfiguredIdentityVerificationKeyInput = Readonly<{
  issuer: string;
  key_id: string;
  algorithm: IdentityJwtAlgorithm;
  public_key_spki_pem: string;
  not_before_epoch: number;
  expires_at_epoch: number;
}>;

/**
 * Exact, startup-validated verification-key resolver for the durable local
 * product root. It contains public material only and cannot discover or fetch a
 * different issuer/key at request time.
 */
export class ConfiguredIdentityVerificationKeyResolver implements IdentityVerificationKeyResolver {
  readonly #issuer: string;
  readonly #key: IdentityVerificationKey;

  constructor(input: ConfiguredIdentityVerificationKeyInput) {
    this.#issuer = validIssuer(input.issuer);
    if (!KEY_ID.test(input.key_id)) throw new Error("IDENTITY_CONFIG_KEY_ID_INVALID");
    if (input.algorithm !== "RS256" && input.algorithm !== "EdDSA") {
      throw new Error("IDENTITY_CONFIG_KEY_ALGORITHM_INVALID");
    }
    if (!Number.isSafeInteger(input.not_before_epoch)
        || !Number.isSafeInteger(input.expires_at_epoch)
        || input.not_before_epoch < 0
        || input.expires_at_epoch <= input.not_before_epoch) {
      throw new Error("IDENTITY_CONFIG_KEY_WINDOW_INVALID");
    }
    if (typeof input.public_key_spki_pem !== "string"
        || Buffer.byteLength(input.public_key_spki_pem, "utf8") > MAX_PUBLIC_KEY_BYTES) {
      throw new Error("IDENTITY_CONFIG_PUBLIC_KEY_INVALID");
    }
    let publicKey;
    try {
      publicKey = createPublicKey({ key: input.public_key_spki_pem, format: "pem", type: "spki" });
    } catch {
      throw new Error("IDENTITY_CONFIG_PUBLIC_KEY_INVALID");
    }
    const expectedType = input.algorithm === "RS256" ? "rsa" : "ed25519";
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== expectedType) {
      throw new Error("IDENTITY_CONFIG_PUBLIC_KEY_ALGORITHM_MISMATCH");
    }
    this.#key = Object.freeze({
      key_id: input.key_id,
      algorithm: input.algorithm,
      public_key: publicKey,
      status: "active" as const,
      not_before_epoch: input.not_before_epoch,
      expires_at_epoch: input.expires_at_epoch,
    });
  }

  async resolve(input: Readonly<{
    issuer: string;
    key_id: string;
    algorithm: IdentityJwtAlgorithm;
  }>): Promise<IdentityVerificationKey | null> {
    return input.issuer === this.#issuer
      && input.key_id === this.#key.key_id
      && input.algorithm === this.#key.algorithm
      ? this.#key
      : null;
  }
}

function validIssuer(value: string): string {
  if (typeof value !== "string" || value.length > 512) throw new Error("IDENTITY_CONFIG_ISSUER_INVALID");
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
        || url.search !== "" || url.hash !== "" || url.origin !== value) {
      throw new Error("IDENTITY_CONFIG_ISSUER_INVALID");
    }
    return value;
  } catch {
    throw new Error("IDENTITY_CONFIG_ISSUER_INVALID");
  }
}
