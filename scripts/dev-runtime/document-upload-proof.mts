// Actual PostgreSQL functions from the migration, in a disposable schema on DEV.
// No production connection, customer rows, storage objects or migration history changed.
import "../production-refusal.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TIVDOC_DEV_PROJECT_REF } from "../supabase-dev-guard/guard.mts";

const env = readDevEnvFile();
assert.equal(env.get("TIVDOC_DEV_PROJECT_REF"), TIVDOC_DEV_PROJECT_REF);
const url = env.get("TIVDOC_DEV_DATABASE_URL");
assert.ok(url && decodeURIComponent(url).includes(TIVDOC_DEV_PROJECT_REF), "DEV connection must name the allowlisted project");
const schema = `upload_proof_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
const peers: pg.Client[] = [];
let passed = 0;
const check = (name: string) => { passed++; console.log(`PASS ${name}`); };
type File = { clientId: string; documentType: string; name: string; type: string; size: number; sha256: string; periodMonth?: string; replace?: { documentId: string; versionId: string } };
type Allocated = File & { documentId: string; versionId: string; path: string; slot: string };
type Batch = { id: string; files: Allocated[] };
const file = (type = "payslip", extra: Partial<File> = {}): File => ({ clientId: randomUUID(), documentType: type, name: `${type}.pdf`, type: "application/pdf", size: 100, sha256: "a".repeat(64), ...(type === "payslip" ? { periodMonth: "2026-08" } : {}), ...extra });
const manifest = (caseId: string, files: File[], extra = {}) => ({ caseId, batchId: randomUUID(), files, ...extra });
async function rpc<T>(client: pg.Client, name: string, args: unknown[]): Promise<T> {
  const result = await client.query(`select ${schema}.case_documents_${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args);
  return result.rows[0].result;
}
async function reserve(client: pg.Client, input: ReturnType<typeof manifest>) { return rpc<Batch>(client, "reserve", [input.caseId, input.batchId, input]); }
async function commit(client: pg.Client, caseId: string, batch: Batch) {
  return rpc<{ documents: Array<{ id: string; version_id: string; original_filename: string }>; status: string; paymentStatus: string }>(client, "commit", [caseId, batch.id, Object.fromEntries(batch.files.map((f) => [f.versionId, f.sha256]))]);
}
async function seed(status = "documents_uploaded", payment = "not_started") {
  const result = await admin.query(`insert into ${schema}.cases(first_name,email,phone,status,payment_status,contact_verified_at,check_period_month)
    values('Synthetic','synthetic@example.invalid','0500000000',$1,$2,now(),'2026-08-01') returning id`, [status, payment]);
  return result.rows[0].id as string;
}
async function expectRefusal(action: Promise<unknown>, code: string) { await assert.rejects(action, (e: Error) => e.message.includes(code)); }

await admin.connect();
try {
  await admin.query(`create schema ${schema}`);
  await admin.query(`create table ${schema}.engine_case_identity (like public.engine_case_identity including all)`);
  for (const table of ["cases", "documents", "case_requests"]) {
    await admin.query(`create table ${schema}.${table} (like public.${table} including all)`);
    await admin.query(`grant select,insert,update,delete on ${schema}.${table} to tivdoc_web_runtime`);
    await admin.query(`alter table ${schema}.${table} enable row level security; alter table ${schema}.${table} force row level security;
      create policy runtime on ${schema}.${table} for all to tivdoc_web_runtime using (true) with check (true)`);
  }
  await admin.query(`create trigger answer_final before update on ${schema}.case_requests for each row execute function public.case_requests_answer_is_final()`);
  await admin.query(`create policy tivdoc_portal_web_owned_case on ${schema}.documents as restrictive for select to tivdoc_web_runtime using (false)`);
  await admin.query(`grant usage on schema ${schema} to tivdoc_web_runtime, anon, authenticated`);
  await admin.query(`alter table ${schema}.documents drop column if exists version_id`);
  await admin.query(`alter table ${schema}.documents drop column if exists product_owner_case_id; alter table ${schema}.documents drop column if exists engine_owner_case_id`);
  // LIKE does not copy foreign keys. Recreate the pre-migration constraint so
  // this proof covers the real product/engine ownership split as well.
  await admin.query(`alter table ${schema}.documents add constraint documents_engine_identity_fkey foreign key(case_id) references ${schema}.engine_case_identity(internal_case_id)`);
  const migration = readFileSync(new URL("../../supabase/migrations/20260907040711_document_upload_integrity.sql", import.meta.url), "utf8");
  await admin.query(migration.replaceAll("public.", `${schema}.`));
  // Test controller seeds/inspects only this disposable schema; runtime still uses its own role.
  for (const table of ["cases", "documents", "case_requests", "document_upload_batches", "document_versions"]) {
    await admin.query(`create policy proof_controller on ${schema}.${table} for all to tivdoc_dev_migrator using (true) with check (true)`);
  }
  for (let i = 0; i < 2; i++) {
    const peer = new pg.Client({ connectionString: env.get("TIVDOC_WEB_POSTGRES_URL"), connectionTimeoutMillis: 15_000 });
    await peer.connect(); peers.push(peer);
  }
  const [a, b] = peers as [pg.Client, pg.Client];
  const caseId = await seed();
  const initial = await reserve(a, manifest(caseId, [file(), file("contract")]));
  await commit(a, caseId, initial);
  const before = (await admin.query(`select * from ${schema}.documents where case_id=$1 order by slot`, [caseId])).rows;
  const additionInput = manifest(caseId, [file()]);
  const second = await reserve(a, additionInput);
  assert.equal(second.files[0].slot, "payslip-02");
  const added = await commit(a, caseId, second);
  assert.equal(added.documents.length, 3);
  for (const old of before) assert.deepEqual((await admin.query(`select * from ${schema}.documents where id=$1`, [old.id])).rows[0], old);
  check("second payslip preserves first payslip and contract rows/paths byte for byte");
  assert.deepEqual(await reserve(a, additionInput), await reserve(b, additionInput));
  assert.equal((await commit(a, caseId, second)).documents.length, 3);
  check("sign retry and commit retry do not allocate or publish twice");

  const old = before.find((d) => d.document_type === "payslip")!;
  const replacement = await reserve(a, manifest(caseId, [file("payslip", { name: "replacement.pdf", replace: { documentId: old.id, versionId: old.version_id } })]));
  assert.notEqual(replacement.files[0].path, old.storage_path);
  await expectRefusal(rpc(a, "commit", [caseId, replacement.id, {}]), "UPLOAD_UNVERIFIED");
  assert.deepEqual((await admin.query(`select * from ${schema}.documents where id=$1`, [old.id])).rows[0], old);
  check("unverified replacement leaves previous document accessible by its original path");
  const replaced = await commit(a, caseId, replacement);
  assert.equal(replaced.documents.length, 3);
  assert.equal(replaced.documents.find((d) => d.id === old.id)?.original_filename, "replacement.pdf");
  assert.equal((await admin.query(`select storage_path from ${schema}.document_versions where version_id=$1`, [old.version_id])).rows[0].storage_path, old.storage_path);
  await expectRefusal(reserve(a, manifest(caseId, [file("payslip", { replace: { documentId: old.id, versionId: old.version_id } })])), "UPLOAD_CONFLICT");
  check("explicit replacement changes only selected document, retains old version, rejects stale replacement");

  const concurrent = await Promise.all([reserve(a, manifest(caseId, [file()])), reserve(b, manifest(caseId, [file()]))]);
  assert.notEqual(concurrent[0].files[0].slot, concurrent[1].files[0].slot);
  await Promise.all([commit(a, caseId, concurrent[0]), commit(b, caseId, concurrent[1])]);
  assert.equal((await rpc<{ documents: unknown[] }>(a, "snapshot", [caseId])).documents.length, 5);
  check("two real PostgreSQL connections allocate distinct slots and both commit");
  const target = replaced.documents.find((d) => d.id === old.id)!;
  const competing = await Promise.allSettled([reserve(a, manifest(caseId, [file("payslip", { replace: { documentId: target.id, versionId: target.version_id } })])), reserve(b, manifest(caseId, [file("payslip", { replace: { documentId: target.id, versionId: target.version_id } })]))]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  check("concurrent replacements have one winner, no lost update");

  const late = await seed("under_review", "verified");
  await commit(a, late, await reserve(a, manifest(late, [file()])));
  const reqs = (await admin.query(`insert into ${schema}.case_requests(case_id,code,question,answer_kind,blocking,expires_at) values
    ($1,'contract_missing','Synthetic contract request','document',true,now()+interval '10 days'),
    ($1,'document_missing','Synthetic unrelated request','document',true,now()+interval '10 days') returning id,code`, [late])).rows;
  const requestId = reqs.find((r) => r.code === "contract_missing").id;
  const contractOnly = await reserve(a, manifest(late, [file("contract")], { requestId }));
  const completed = await commit(a, late, contractOnly);
  assert.equal(completed.documents.length, 2); assert.equal(completed.status, "under_review"); assert.equal(completed.paymentStatus, "verified");
  const answered = (await admin.query(`select code from ${schema}.case_requests where case_id=$1 and answered_at is not null`, [late])).rows;
  assert.deepEqual(answered.map((r) => r.code), ["contract_missing"]);
  check("contract-only completion answers exactly its request and preserves paid case status");
  const other = await seed();
  await expectRefusal(rpc(a, "batch", [other, second.id]), "UPLOAD_FORBIDDEN");
  await expectRefusal(rpc(a, "commit", [other, second.id, {}]), "UPLOAD_FORBIDDEN");
  await expectRefusal(reserve(a, manifest(other, [file("payslip", { replace: { documentId: target.id, versionId: target.version_id } })])), "UPLOAD_FORBIDDEN");
  await expectRefusal(reserve(a, manifest(other, [file()], { requestId })), "UPLOAD_REQUEST_CONFLICT");
  check("cross-case batch, completion, replacement and request references refused");
  const unverified = await seed();
  await admin.query(`update ${schema}.cases set contact_verified_at=null where id=$1`, [unverified]);
  await expectRefusal(reserve(a, manifest(unverified, [file()])), "UPLOAD_FORBIDDEN");
  check("unverified contact refused inside database function");

  const limited = await seed();
  await commit(a, limited, await reserve(a, manifest(limited, [file("payslip", { size: 10*1024*1024 }), file("contract", { size: 10*1024*1024 })])));
  const quotaRace = await Promise.allSettled([reserve(a, manifest(limited, [file("payslip", { size: 4*1024*1024 })])), reserve(b, manifest(limited, [file("payslip", { size: 4*1024*1024 })]))]);
  assert.equal(quotaRace.filter((r) => r.status === "fulfilled").length, 1);
  check("aggregate case byte quota includes concurrent pending uploads");
  const full = await seed();
  await commit(a, full, await reserve(a, manifest(full, Array.from({ length: 12 }, () => file()))));
  await expectRefusal(reserve(b, manifest(full, [file()])), "UPLOAD_LIMIT");
  await expectRefusal(reserve(a, manifest(other, [file("payslip", { type: "text/html" })])), "UPLOAD_INVALID");
  await expectRefusal(reserve(a, manifest(other, [file("payslip", { size: 10485761 })])), "UPLOAD_INVALID");
  check("server enforces case count, file type and individual size");

  const cancelInput = manifest(other, [file()]);
  await rpc(a, "cancel", [other, cancelInput.batchId]);
  await expectRefusal(reserve(b, cancelInput), "UPLOAD_RETRY_MISMATCH");
  const expired = await reserve(a, manifest(other, [file()]));
  await admin.query(`update ${schema}.document_upload_batches set expires_at=now()-interval '1 second' where id=$1`, [expired.id]);
  await expectRefusal(commit(a, other, expired), "UPLOAD_EXPIRED");
  check("cancellation tombstone and expired reservation cannot publish later");
  const atomicCase = await seed("awaiting_document");
  const req = (await admin.query(`insert into ${schema}.case_requests(case_id,code,question,answer_kind,blocking,expires_at)
    values($1,'document_missing','Synthetic payslip request','document',true,now()+interval '10 days') returning id`, [atomicCase])).rows[0].id;
  const atomic = await reserve(a, manifest(atomicCase, [file()], { requestId: req }));
  await admin.query(`update ${schema}.case_requests set answered_at=now(), answer_text='Already answered' where id=$1`, [req]);
  await expectRefusal(commit(a, atomicCase, atomic), "UPLOAD_REQUEST_CONFLICT");
  assert.equal((await admin.query(`select count(*)::int n from ${schema}.documents where case_id=$1`, [atomicCase])).rows[0].n, 0);
  assert.equal((await admin.query(`select status from ${schema}.cases where id=$1`, [atomicCase])).rows[0].status, "awaiting_document");
  check("failure after document writes rolls back documents, case and batch atomically");
  const grants = await admin.query(`select has_function_privilege('anon', '${schema}.case_documents_commit(uuid,uuid,jsonb)', 'execute') as anon,
    has_function_privilege('authenticated', '${schema}.case_documents_reserve(uuid,uuid,jsonb)', 'execute') as authenticated`);
  assert.deepEqual(grants.rows[0], { anon: false, authenticated: false });
  check("anonymous and authenticated browser roles cannot call mutation functions");
  const canonicalId = randomUUID();
  await admin.query(`insert into ${schema}.engine_case_identity(internal_case_id,tenant_id,canonical_case_id) values($1,'synthetic-engine','synthetic-case')`, [canonicalId]);
  await admin.query(`insert into ${schema}.documents(case_id,document_type,slot,storage_path,original_filename,mime_type,size,tenant_id,canonical_case_id,canonical_document_id)
    values($1,'payslip','payslip-01','synthetic-engine/document.pdf','engine.pdf','application/pdf',100,'synthetic-engine','synthetic-case','engine-document')`, [canonicalId]);
  assert.equal((await a.query(`select id from ${schema}.documents where case_id=$1`, [canonicalId])).rows.length, 0);
  await assert.rejects(admin.query(`delete from ${schema}.engine_case_identity where internal_case_id=$1`, [canonicalId]), (e: { code: string }) => e.code === "23503");
  check("canonical engine documents retain ownership restriction and engine FK");
  const paused = await seed("awaiting_document");
  const pauseRequest = (await admin.query(`insert into ${schema}.case_requests(case_id,code,question,answer_kind,blocking,expires_at)
    values($1,'document_missing','Synthetic payslip request','document',true,now()+interval '10 days') returning id`, [paused])).rows[0].id;
  const resumed = await commit(a, paused, await reserve(a, manifest(paused, [file()], { requestId: pauseRequest })));
  assert.equal(resumed.status, "documents_uploaded");
  assert.equal(resumed.paymentStatus, "not_started");
  check("late requested payslip resumes the unpaid funnel atomically");
  console.log(JSON.stringify({ passed, database: "isolated DEV schema; actual PostgreSQL; two runtime connections", storage: "not exercised by this proof" }));
} finally {
  for (const peer of peers) await peer.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
  console.log("Disposable schema removed; production and DEV public schema unchanged.");
}
