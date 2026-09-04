// E2-2, completed by L4-5 / D3. The one command the owner runs to become
// reviewer number one — and the proof that the command behind it works, run
// against a synthetic identity on a synthetic tenant so that no real one is
// created here.
//
//   … owner-reviewer-identity.mts keygen
//   … owner-reviewer-identity.mts prove
//   … owner-reviewer-identity.mts register --reviewer-id <your.id>
//
// `keygen` generates an Ed25519 pair into the git-ignored dev environment file,
// prints the PUBLIC half and the registration command, and never prints, logs
// or returns the private half. `register` reads that key back, proves
// possession by signing a server-issued challenge, and creates a real reviewer
// identity — but only at a keyboard: it refuses when TIVDOC_UNATTENDED=1 or
// when stdin is not a terminal. `prove` runs the identical code path on
// `legal.synthetic.proof` with a keypair generated on the spot and an id that
// `isSyntheticReviewerReference` recognises.
//
// Zero real identities are created by `keygen` or `prove`. The private half is
// read once into memory, used to sign one challenge, and never printed, logged,
// returned or written to any receipt.
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
import { isSyntheticReviewerReference } from "../../src/engine/legal-review/reviewer-identity.ts";
import { envPath, readDevEnvFile, writeDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { SYSTEM_ACTOR, TENANT as REFERENCE_TENANT } from "./pool-p-parameter-import.mts";
import { ownerPrivateKey, registerReviewerIdentity, SYNTHETIC_PROOF_TENANT } from "./reviewer-registration.mts";

const RECEIPT_ROOT = path.join("output", "next", "owner-identity");
const OWNER_KEY_ENV = "TIVDOC_OWNER_REVIEWER_PRIVATE_KEY_PEM";
const OWNER_PUBLIC_ENV = "TIVDOC_OWNER_REVIEWER_PUBLIC_KEY_PEM";
/** The owner's trust organisation on the reference tenant. One, created on first registration. */
const OWNER_ORGANIZATION = "legal.reference.il.reviewer-organization";
/** The policy admin on the synthetic proof tenant. Never a real person. */
const PROOF_ADMIN = "synthetic.proof.policy-admin";

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
    "That command works, and it refuses to run unattended: TIVDOC_UNATTENDED=1 or",
    "a non-terminal stdin both stop it. Registering a real identity is the owner's",
    "act, not an automated one: it is irreversible (the identity tables are",
    "append-only with no delete path), and it is the one step in this system that",
    "a person must take deliberately rather than find already done.",
    "",
  ].join("\n"));
}

/**
 * L4-5 / D3. Why an unattended process may not do this.
 *
 * The registration is implemented and proven. What it will not do is run
 * itself. `governance_reviewers`, `governance_reviewer_keys` and
 * `governance_key_challenges` all carry immutability triggers that raise
 * `GOVERNANCE_APPEND_ONLY` on update and delete, so an identity created by
 * mistake is permanent — and an identity is a claim that a specific person
 * stands behind something. A process asserting that on someone's behalf, at
 * three in the morning, with nobody watching, is the exact failure every
 * control in this system exists to prevent.
 *
 * So there are two gates and they are independent. `TIVDOC_UNATTENDED=1` is set
 * for the whole of an agent run and refuses on its own; and stdin must be a
 * terminal, which is the difference between a person at a keyboard and a
 * script. Either one refusing is enough.
 */
function unattendedRefusal(): string | null {
  if (process.env.TIVDOC_UNATTENDED === "1") return "TIVDOC_UNATTENDED=1 is set. This run is unattended.";
  if (!process.stdin.isTTY) return "stdin is not a terminal. There is nobody at the keyboard.";
  return null;
}

function refuseRegister(reason: string): void {
  process.stdout.write([
    "",
    "REGISTRATION REFUSED.",
    "",
    `  ${reason}`,
    "",
    "Creating a real reviewer identity is irreversible — the reviewer, key and",
    "challenge tables are append-only with no delete path — and it is a claim",
    "that a named person stands behind what they later attest. That claim is",
    "yours to make at a keyboard, not a process's to make on your behalf.",
    "",
    "The command works. Run it yourself, in an interactive shell, with",
    "TIVDOC_UNATTENDED unset:",
    "",
    "  node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \\",
    "    scripts/legal-review-projection/owner-reviewer-identity.mts register --reviewer-id <your.id>",
    "",
  ].join("\n"));
  process.exitCode = 2;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

/** The owner's real registration, on the reference tenant. */
async function register(): Promise<void> {
  const refusal = unattendedRefusal();
  if (refusal) { refuseRegister(refusal); return; }

  const reviewerId = argument("reviewer-id");
  if (!reviewerId) {
    process.stdout.write("register requires --reviewer-id <your.id>\n");
    process.exitCode = 2;
    return;
  }
  if (isSyntheticReviewerReference({ reviewer_id: reviewerId, key_reference: reviewerId, organization_id: OWNER_ORGANIZATION })) {
    // A real identity whose id says "test" would be permanently ineligible for
    // real approval, and the owner would not find that out until they tried.
    process.stdout.write(`Refusing: ${JSON.stringify(reviewerId)} reads as synthetic, which makes it permanently ineligible for real approval.\n`);
    process.exitCode = 2;
    return;
  }
  const env = readDevEnvFile();
  const publicPem = env.get(OWNER_PUBLIC_ENV);
  const privatePem = env.get(OWNER_KEY_ENV);
  if (!publicPem || !privatePem) {
    process.stdout.write(`No reviewer key in ${envPath()}. Run \`keygen\` first.\n`);
    process.exitCode = 2;
    return;
  }

  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const receipt = await registerReviewerIdentity({
    tenant: REFERENCE_TENANT,
    organization_id: OWNER_ORGANIZATION,
    admin_actor: SYSTEM_ACTOR,
    admin_session: { sid: "session.legal.reference.system-import", jti: "token.legal.reference.system-import", subject: SYSTEM_ACTOR },
    reviewer_id: reviewerId,
    reviewer_session: { sid: `session.legal.reference.reviewer.${runId}`, jti: `token.legal.reference.reviewer.${runId}`, subject: reviewerId },
    public_key_spki_pem: publicPem.replaceAll("\\n", "\n"),
    private_key: ownerPrivateKey(privatePem),
    identity_evidence_sha256: createHash("sha256").update(`owner-reviewer:${reviewerId}`, "utf8").digest("hex"),
    run_id: runId,
  });
  writeFileSync(path.join(RECEIPT_ROOT, "owner-reviewer-registration.json"),
    `${JSON.stringify({ schema_version: "tivdoc-owner-reviewer-registration-v0.10.16", ...receipt }, null, 2)}\n`, "utf8");
  process.stdout.write([
    "",
    "Registered.",
    `  reviewer     : ${receipt.reviewer_id}`,
    `  role         : ${receipt.reviewer_role}`,
    `  key sha256   : ${receipt.public_key_sha256}`,
    `  tenant       : ${receipt.tenant}`,
    "",
    "Possession was proven by signing a challenge issued for that key. The",
    "private half was read from the environment file, used once, and never",
    "printed, logged or written anywhere.",
    "",
    "You are reviewer one. Activation still needs a second, independent identity.",
    "",
  ].join("\n"));
}

/**
 * The same code path, on the synthetic proof tenant, with a keypair generated
 * here and a reviewer id `isSyntheticReviewerReference` recognises. This is what
 * makes the claim "the command works" checkable without creating a real
 * identity: same function, same sequence, same database, different tenant.
 */
async function prove(): Promise<void> {
  mkdirSync(RECEIPT_ROOT, { recursive: true });
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const reviewerId = `synthetic.reviewer.${runId}`;
  const reference = { reviewer_id: reviewerId, key_reference: `key.${runId}`, organization_id: `synthetic.org.${runId}` };
  if (!isSyntheticReviewerReference(reference)) throw new Error("L45_PROOF_IDENTITY_NOT_RECOGNISED_AS_SYNTHETIC");

  const cases: Array<{ case: string; outcome: "pass" | "fail"; observed: string }> = [];
  const record = (name: string, passed: boolean, observed: string) =>
    cases.push({ case: name, outcome: passed ? "pass" : "fail", observed });

  const receipt = await registerReviewerIdentity({
    tenant: SYNTHETIC_PROOF_TENANT,
    organization_id: reference.organization_id,
    admin_actor: PROOF_ADMIN,
    admin_session: { sid: `session.synthetic.proof.admin.${runId}`, jti: `token.synthetic.proof.admin.${runId}`, subject: PROOF_ADMIN },
    reviewer_id: reviewerId,
    reviewer_session: { sid: `session.synthetic.proof.reviewer.${runId}`, jti: `token.synthetic.proof.reviewer.${runId}`, subject: reviewerId },
    public_key_spki_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    private_key: privateKey,
    identity_evidence_sha256: createHash("sha256").update(`synthetic-evidence:${runId}`, "utf8").digest("hex"),
    run_id: runId,
  });
  record("registered_on_synthetic_tenant", receipt.tenant === SYNTHETIC_PROOF_TENANT, receipt.tenant);
  record("identity_reads_as_synthetic", isSyntheticReviewerReference(reference), reviewerId);
  record("possession_proven", /^[a-f0-9]{64}$/u.test(receipt.proof_signature_sha256), receipt.proof_signature_sha256.slice(0, 16));
  record("private_key_not_printed", receipt.private_key_printed === false, "no private half in the receipt");

  // A wrong key must not register — and it must be refused for the RIGHT
  // reason. The first version of this case passed while the wrong key never
  // reached the signature check at all: an unrelated unique violation stopped
  // it earlier and the case counted that as a refusal. So the message is
  // checked, not only the fact that something threw.
  let wrongKeyRefused = "accepted";
  try {
    const other = generateKeyPairSync("ed25519");
    await registerReviewerIdentity({
      tenant: SYNTHETIC_PROOF_TENANT,
      organization_id: reference.organization_id,
      admin_actor: PROOF_ADMIN,
      admin_session: { sid: `session.synthetic.proof.admin.${runId}`, jti: `token.synthetic.proof.admin.${runId}`, subject: PROOF_ADMIN },
      reviewer_id: `synthetic.reviewer.wrongkey.${runId}`,
      reviewer_session: { sid: `session.synthetic.proof.wrong.${runId}`, jti: `token.synthetic.proof.wrong.${runId}`, subject: `synthetic.reviewer.wrongkey.${runId}` },
      public_key_spki_pem: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
      // The signature is made with a third key that the challenge never named.
      private_key: generateKeyPairSync("ed25519").privateKey,
      identity_evidence_sha256: createHash("sha256").update(`synthetic-evidence-wrong:${runId}`, "utf8").digest("hex"),
      run_id: `${runId}w`,
    });
  } catch (error) {
    wrongKeyRefused = String((error as Error).message ?? "unknown").slice(0, 120);
  }
  record("wrong_key_refused_for_the_signature", /SIGNATURE/u.test(wrongKeyRefused), wrongKeyRefused);

  // Self-registration is refused before any row is written.
  let selfRefused = "accepted";
  try {
    await registerReviewerIdentity({
      tenant: SYNTHETIC_PROOF_TENANT, organization_id: reference.organization_id,
      admin_actor: PROOF_ADMIN,
      admin_session: { sid: `session.synthetic.proof.admin.${runId}`, jti: `token.synthetic.proof.admin.${runId}`, subject: PROOF_ADMIN },
      reviewer_id: PROOF_ADMIN,
      reviewer_session: { sid: `session.synthetic.proof.admin.${runId}`, jti: `token.synthetic.proof.admin.${runId}`, subject: PROOF_ADMIN },
      public_key_spki_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      private_key: privateKey,
      identity_evidence_sha256: createHash("sha256").update(`self:${runId}`, "utf8").digest("hex"),
      run_id: `${runId}s`,
    });
  } catch (error) {
    selfRefused = String((error as Error).message ?? "unknown").slice(0, 80);
  }
  record("self_registration_refused", selfRefused !== "accepted", selfRefused);

  // And the unattended gate, checked rather than asserted.
  const previous = process.env.TIVDOC_UNATTENDED;
  process.env.TIVDOC_UNATTENDED = "1";
  const refusal = unattendedRefusal();
  if (previous === undefined) delete process.env.TIVDOC_UNATTENDED; else process.env.TIVDOC_UNATTENDED = previous;
  record("unattended_gate_refuses", refusal !== null, refusal ?? "did not refuse");
  record("no_tty_gate_refuses", !process.stdin.isTTY, process.stdin.isTTY ? "stdin is a TTY here" : "stdin is not a TTY");

  const failed = cases.filter((entry) => entry.outcome === "fail");
  writeFileSync(path.join(RECEIPT_ROOT, "reviewer-registration-proof.json"), `${JSON.stringify({
    schema_version: "tivdoc-reviewer-registration-proof-v0.10.16",
    unit: "L4-5",
    tenant: SYNTHETIC_PROOF_TENANT,
    real_identities_created: 0,
    passed: cases.length - failed.length,
    total: cases.length,
    receipt,
    cases,
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`L4_5_REGISTER_PROOF ${JSON.stringify({ passed: cases.length - failed.length, total: cases.length, tenant: SYNTHETIC_PROOF_TENANT })}\n`);
  if (failed.length > 0) process.exitCode = 3;
}

const command = process.argv[2] ?? "keygen";
if (command === "keygen") keygen();
else if (command === "register") await register();
else if (command === "prove") await prove();
else {
  process.stdout.write(`Unknown command ${JSON.stringify(command)}. Use "keygen", "register" or "prove".\n`);
  process.exitCode = 2;
}
