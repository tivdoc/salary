// Wave 6 (K-1, K-2, K-3, K-5). Custody of this run's evidence, executed where
// it can be executed and stated where it cannot.
//
// K-1/K-2: every receipt this run wrote under output/<wave>/audit is sealed
// into an immutable local evidence store — an append-only, hash-chained index
// over the files and an append-only, hash-chained access log naming every
// append, read and walk with actor and purpose. Sealing is append-only across
// runs: a receipt that has changed since it was last sealed is sealed again
// under a digest-suffixed path; the earlier copy is never touched. The walk
// runs last and must be valid.
//
// K-3: a restore drill. Every sealed file is written to the local immutable
// private provider (the non-managed runtime lane's real storage adapter:
// quarantine, promote, content-hash verified on every read), then restored to
// a clean location and compared byte-for-byte; the receipt carries both
// digests per object. The managed destination — the DEV project's private
// `salary-documents` bucket — is not reachable from this host: the only DEV
// credentials here are Postgres role passwords, and a Storage write needs a
// Storage API key. That half is recorded as blocked_dependency with the exact
// key it needs, not run against something else and called done.
//
// K-5: off-host replicated custody stays blocked_external. The requirements a
// provisioner needs are in docs/off-host-custody-requirements.md; the
// capability report here is the code's own, unchanged.
//
// Nothing here touches customer data, the database, or any network.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ImmutableEvidenceStore } from "../../src/server/platform/custody/evidence-store.ts";
import { offHostCustodyCapability } from "../../src/server/platform/custody/replication.ts";
import { LocalRuntimePrivateBlobProvider } from "../../src/server/platform/storage/local-runtime/private-blob-provider.ts";

const WAVE = process.env.TIVDOC_WAVE_OUTPUT ?? "v4";
const AUDIT_ROOT = path.join("output", WAVE, "audit");
const EVIDENCE_ROOT = path.resolve("output", WAVE, "evidence", "store");
const DRILL_ROOT = path.resolve("output", WAVE, "evidence", "tivdoc-private-runtime-drill");
const RESTORE_ROOT = path.resolve("output", WAVE, "evidence", "restore");
const ACTOR = Object.freeze({ actor_id: "custody.run.wave6", purpose: "evidence_custody" });
const RUN = new Date().toISOString().replaceAll(/[-:.]/gu, "").slice(0, 15);

type Outcome = Readonly<{ case: string; outcome: "pass" | "fail"; observed: string }>;
const results: Outcome[] = [];
function record(name: string, pass: boolean, observed: string): void {
  results.push(Object.freeze({ case: name, outcome: pass ? "pass" : "fail", observed }));
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The receipts this run wrote: JSON and text under the audit root, never scripts. */
function receiptFiles(): readonly string[] {
  if (!existsSync(AUDIT_ROOT)) return [];
  return readdirSync(AUDIT_ROOT)
    .filter((name) => /\.(json|txt)$/u.test(name) && statSync(path.join(AUDIT_ROOT, name)).isFile())
    .sort();
}

async function main(): Promise<void> {
  mkdirSync(AUDIT_ROOT, { recursive: true });

  // --- K-1/K-2: seal the receipts, append-only across runs.
  const store = new ImmutableEvidenceStore({ root: EVIDENCE_ROOT });
  const indexed = new Map((await store.index()).map((entry) => [entry.relative_path, entry.sha256]));
  const sealed: string[] = [];
  const unchanged: string[] = [];
  const superseded: string[] = [];
  for (const name of receiptFiles()) {
    if (name === "evidence-custody.json") continue; // this receipt is written after the walk
    const bytes = readFileSync(path.join(AUDIT_ROOT, name));
    const digest = sha256(bytes);
    const primary = `receipts/${name}`;
    if (!indexed.has(primary)) {
      await store.append({ ...ACTOR, relative_path: primary, bytes });
      sealed.push(primary);
      continue;
    }
    if (indexed.get(primary) === digest) {
      unchanged.push(primary);
      continue;
    }
    const versioned = `receipts/${name.replace(/\.(json|txt)$/u, "")}@${digest.slice(0, 12)}.${name.split(".").pop()}`;
    if (indexed.has(versioned)) {
      unchanged.push(versioned);
      continue;
    }
    await store.append({ ...ACTOR, relative_path: versioned, bytes });
    sealed.push(versioned);
    superseded.push(primary);
  }
  record("K1_receipts_sealed_append_only",
    sealed.length + unchanged.length > 0,
    `sealed ${sealed.length}, unchanged ${unchanged.length}, re-sealed under a digest suffix ${superseded.length}`);

  // --- K-3: the restore drill against the local immutable private provider.
  const provider = new LocalRuntimePrivateBlobProvider({
    root: DRILL_ROOT, runtime_class: "ignored_local_private_filesystem",
    publicly_addressable: false, managed_platform_verified: false,
  });
  const restoreRoot = path.join(RESTORE_ROOT, RUN);
  await mkdir(restoreRoot, { recursive: true });
  const drill: Array<Readonly<{
    relative_path: string; source_sha256: string; byte_count: number; locator: string;
    restored_sha256: string; byte_equal: boolean;
  }>> = [];
  for (const entry of await store.index()) {
    const bytes = await store.read({ ...ACTOR, relative_path: entry.relative_path });
    const objectKey = `object_${entry.sha256.slice(0, 48)}`;
    let locator: string;
    try {
      const quarantine = await provider.putQuarantined({
        object_key: objectKey, expected_sha256: entry.sha256, expected_length: entry.byte_count, bytes,
      });
      locator = (await provider.promoteQuarantined({
        quarantine_locator: quarantine.quarantine_locator, object_key: objectKey,
        expected_sha256: entry.sha256, expected_length: entry.byte_count,
      })).active_locator;
    } catch (error) {
      // An earlier run already promoted this exact object: the provider keeps
      // active objects immutable, so the write is refused and the locator is
      // the deterministic one.
      if (!/EXISTS|COLLISION|IMMUTABLE/u.test(String((error as Error).message))) throw error;
      locator = `objects/${entry.sha256.slice(0, 2)}/${objectKey}`;
    }
    const restored = await provider.readExact({ locator, expected_sha256: entry.sha256, expected_length: entry.byte_count });
    const target = path.join(restoreRoot, ...entry.relative_path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, restored, { flag: "wx" });
    const back = await readFile(target);
    const restoredSha = sha256(back);
    drill.push(Object.freeze({
      relative_path: entry.relative_path, source_sha256: entry.sha256, byte_count: entry.byte_count, locator,
      restored_sha256: restoredSha, byte_equal: back.byteLength === bytes.byteLength && back.equals(Buffer.from(bytes)),
    }));
  }
  record("K3_restore_drill_local_immutable_provider",
    drill.length > 0 && drill.every((item) => item.byte_equal && item.restored_sha256 === item.source_sha256),
    `${drill.length} objects written, restored to a clean location, compared byte-for-byte; ${drill.filter((i) => i.byte_equal).length} equal`);
  const managedBucket = Object.freeze({
    status: "blocked_dependency",
    destination: "Supabase DEV project private bucket `salary-documents` (public=false)",
    reason: "no Storage API credential on this host: ~/.tivdoc-dev/credentials.env holds Postgres role passwords only, and the SupabasePrivateBlobProvider transport needs a Storage key to upload, download and list",
    unblocks_when: "a Storage service key scoped to the DEV project is placed in ~/.tivdoc-dev/credentials.env as TIVDOC_DEV_STORAGE_SERVICE_KEY (never committed, never logged), and a SupabasePrivateStorageTransport over storage/v1 is implemented against it; the drill then runs the same write, checksum, restore and compare against the bucket",
  });
  record("K3_managed_bucket_half_named_not_faked", true, `${managedBucket.status}: ${managedBucket.reason.slice(0, 120)}`);

  // --- K-5: off-host custody, as the code reports it.
  const offHost = offHostCustodyCapability();
  record("K5_off_host_custody_blocked_external",
    offHost.status === "BLOCKED" && offHost.managed_destination_verified === false,
    `${offHost.status} ${offHost.blocker_codes.join(",")}; requirements in docs/off-host-custody-requirements.md`);

  // --- The walk, last: index chain, access-log chain, tree, all against each other.
  const walk = await store.walk(ACTOR);
  record("K1_K2_walk_valid", walk.valid,
    `entries ${walk.entry_count}, bytes ${walk.byte_count}, index head ${walk.index_head_sha256?.slice(0, 16) ?? "-"}…, access entries ${walk.access_count}, breaks ${walk.breaks.length}`);
  const accessLog = await store.accessLog();
  record("K2_every_access_named",
    accessLog.length > 0 && accessLog.every((entry) => entry.actor_id === ACTOR.actor_id && entry.purpose === ACTOR.purpose),
    `${accessLog.length} entries: ${["append", "read", "walk"].map((op) => `${op} ${accessLog.filter((e) => e.operation === op).length}`).join(", ")}`);

  const failed = results.filter((entry) => entry.outcome === "fail");
  const receipt = {
    schema_version: "tivdoc-evidence-custody-wave6",
    observed_at: new Date().toISOString(),
    run_id: RUN,
    evidence_store: { proof: store.proof(), sealed, unchanged, superseded, walk },
    restore_drill: {
      target_class: "local_private_immutable_filesystem",
      provider_proof: provider.proof(),
      restore_location: path.relative(process.cwd(), restoreRoot).replaceAll("\\", "/"),
      objects: drill,
      managed_bucket: managedBucket,
    },
    off_host_custody: { disposition: "blocked_external", capability: offHost, requirements: "docs/off-host-custody-requirements.md" },
    cases: results.length, passed: results.length - failed.length, failed: failed.length, results,
  };
  writeFileSync(path.join(AUDIT_ROOT, "evidence-custody.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`cases=${results.length} passed=${results.length - failed.length} failed=${failed.length}`
    + `${failed.length > 0 ? ` failing=${failed.map((f) => f.case).join(",")}` : ""}\n`);
  for (const entry of results) process.stdout.write(`  ${entry.outcome} ${entry.case} :: ${entry.observed.slice(0, 200)}\n`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
