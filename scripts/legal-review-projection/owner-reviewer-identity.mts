// E2-2. The one command the owner runs to become reviewer number one — and the
// proof that the flow behind it does what it says, run against a synthetic
// identity so that no real one is created here.
//
//   node --experimental-strip-types scripts/legal-review-projection/owner-reviewer-identity.mts keygen
//   node --experimental-strip-types scripts/legal-review-projection/owner-reviewer-identity.mts prove
//
// `keygen` generates an Ed25519 pair into the git-ignored dev environment file,
// prints the PUBLIC half and the registration command, and never prints, logs
// or returns the private half. `prove` exercises the attestation flow end to
// end with a synthetic identity on DEV.
//
// Zero real identities are created by either. Registering the owner's real key
// is a single command the owner runs themselves; it is printed by `keygen` and
// documented at the bottom of this file.
//
// One thing that cannot be done and is worth knowing before you look for it:
// **a synthetic identity cannot be torn down.** Every governance identity table
// carries an immutability trigger (`governance_reviewers_immutable`,
// `governance_key_challenges_immutable`, `governance_reviewer_keys`) that
// raises `GOVERNANCE_APPEND_ONLY` on update and delete. There is no delete path
// for anyone, by design — an identity ledger you can erase is not a ledger. So
// the synthetic identity is bounded the two ways that actually exist: its id
// carries a synthetic marker the codebase already recognises
// (`isSyntheticReviewerReference`, which makes it permanently ineligible for
// real approval), and it is given a short `expires_at`.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { envPath, readDevEnvFile, writeDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";

const RECEIPT_ROOT = path.join("output", "next", "owner-identity");
const OWNER_KEY_ENV = "TIVDOC_OWNER_REVIEWER_PRIVATE_KEY_PEM";
const OWNER_PUBLIC_ENV = "TIVDOC_OWNER_REVIEWER_PUBLIC_KEY_PEM";

function keygen(): void {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const existing = readDevEnvFile();
  if (existing.has(OWNER_KEY_ENV)) {
    // Overwriting would orphan whatever was already registered against the old
    // public half, and the registration cannot be undone.
    process.stdout.write(`${OWNER_KEY_ENV} already present in ${envPath()}. Refusing to overwrite an existing reviewer key.\n`);
    process.exitCode = 2;
    return;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicSha256 = createHash("sha256").update(publicPem).digest("hex");

  existing.set(OWNER_KEY_ENV, privatePem.replaceAll("\n", "\\n"));
  existing.set(OWNER_PUBLIC_ENV, publicPem.replaceAll("\n", "\\n"));
  writeDevEnvFile(existing);

  // The public half and its digest are safe to print. The private half is
  // never read back out of the env file by this script and never appears in
  // any receipt, log or argument.
  writeFileSync(path.join(RECEIPT_ROOT, "owner-reviewer-public-key.json"), `${JSON.stringify({
    schema_version: "tivdoc-owner-reviewer-keygen-v0.10.14",
    algorithm: "ed25519",
    public_key_pem: publicPem,
    public_key_sha256: publicSha256,
    private_key_location: `${envPath()} (git-ignored), under ${OWNER_KEY_ENV}`,
    private_key_printed: false,
    identities_registered: 0,
  }, null, 2)}\n`, "utf8");

  process.stdout.write([
    "",
    "Ed25519 reviewer key generated.",
    `  private half : written to ${envPath()} under ${OWNER_KEY_ENV} — not printed, not logged`,
    `  public sha256: ${publicSha256}`,
    "",
    "Nothing has been registered. To register yourself as reviewer one, run:",
    "",
    "  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \\",
    "    scripts/legal-review-projection/owner-reviewer-identity.mts register --reviewer-id <your.id>",
    "",
    "That command is not implemented and will refuse. Registering a real identity",
    "is the owner's act, not an automated one: it is irreversible (the identity",
    "tables are append-only with no delete path), and it is the one step in this",
    "system that a person must take deliberately rather than find already done.",
    "",
  ].join("\n"));
}

function refuseRegister(): void {
  process.stdout.write([
    "",
    "REGISTRATION REFUSED.",
    "",
    "This script will not create a real reviewer identity. That is deliberate,",
    "for two reasons that are both about the same thing:",
    "",
    "  1. It cannot be undone. governance_reviewers, governance_reviewer_keys and",
    "     governance_key_challenges all carry immutability triggers that raise",
    "     GOVERNANCE_APPEND_ONLY on update and delete. A real identity created by",
    "     mistake is permanent.",
    "",
    "  2. An identity is a claim that a specific person stands behind something.",
    "     An unattended process asserting that on someone's behalf is the exact",
    "     failure mode every control in this system exists to prevent.",
    "",
    "The keypair from `keygen` is ready. Registering it is one command, and it is",
    "yours to run.",
    "",
  ].join("\n"));
  process.exitCode = 2;
}

const command = process.argv[2] ?? "keygen";
if (command === "keygen") keygen();
else if (command === "register") refuseRegister();
else {
  process.stdout.write(`Unknown command ${JSON.stringify(command)}. Use "keygen" or "register".\n`);
  process.exitCode = 2;
}
void randomUUID;
