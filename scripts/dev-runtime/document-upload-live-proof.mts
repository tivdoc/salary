// Local Next.js HTTP handlers + the allowlisted DEV replay DB + real private Storage.
// Use --hold to inspect the seeded synthetic case with playwright-cli; a STOP file ends it.
import "../production-refusal.mjs";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readDevEnvFile } from "../supabase-dev-guard/dev-credential.mts";
import { TIVDOC_DEV_PROJECT_REF } from "../supabase-dev-guard/guard.mts";
import { buildRuntimeEnvironment, freePort, startServer, waitForServer } from "./serve.mts";
import { hashSession } from "../../src/server/product/case-access/crypto.ts";

const env = readDevEnvFile();
assert.equal(env.get("TIVDOC_DEV_PROJECT_REF"), TIVDOC_DEV_PROJECT_REF);
const lookup = spawnSync("npx.cmd", ["--yes", "supabase", "projects", "api-keys", "--project-ref", TIVDOC_DEV_PROJECT_REF, "--output", "json"], { encoding: "utf8", shell: true, windowsHide: true });
assert.equal(lookup.status, 0, "DEV Storage credential lookup unavailable");
const keys = JSON.parse(lookup.stdout) as { name: string; api_key: string }[];
const key = keys.find((entry) => entry.name === "service_role")?.api_key;
assert.ok(key, "DEV service credential unavailable");
const supabaseUrl = `https://${TIVDOC_DEV_PROJECT_REF}.supabase.co`;
const storage = createClient(supabaseUrl, key, { auth: { persistSession: false } }).storage.from("salary-documents");
const scratch = path.resolve("../upload-verification");
mkdirSync(scratch, { recursive: true });
const stopFile = path.join(scratch, "STOP");
rmSync(stopFile, { force: true });
const port = await freePort();
const secret = randomBytes(32).toString("hex");
const session = randomBytes(16).toString("base64url");
const productionBuild = process.argv.includes("--production");
const environment = { ...buildRuntimeEnvironment({ port, node_env: productionBuild ? "production" : "development" }), CASE_TOKEN_SECRET: secret,
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: key,
  // Exercise the same product route guards as a closed preview, on loopback only.
  TIVDOC_DURABLE_PRODUCT_RUNTIME_ENABLED: "0", VERCEL_ENV: "preview" };
const origin = `http://localhost:${port}`;
const client = new pg.Client({ connectionString: env.get("TIVDOC_DEV_DATABASE_URL"), connectionTimeoutMillis: 15_000 });
await client.connect();
const runtimeDb = new pg.Client({ connectionString: env.get("TIVDOC_WEB_POSTGRES_URL"), connectionTimeoutMillis: 15_000 });
await runtimeDb.connect();
const cases: string[] = [];
let identityId: string | undefined;
let server: ReturnType<typeof startServer> | undefined;
let passed = 0;
const check = (name: string) => { passed++; console.log(`PASS ${name}`); };
const caseCookie = (id: string) => `${id}.${createHmac("sha256", secret).update(id).digest("base64url")}`;
async function seed() {
  const row = (await client.query("insert into public.cases(first_name,email,phone,status,payment_status,contact_verified_at,check_period_month) values('Synthetic upload', $1,'0500000000','under_review','verified',now(),'2026-08-01') returning id,public_id", [`upload-${randomUUID()}@example.invalid`])).rows[0];
  cases.push(row.id); return row as { id: string; public_id: string };
}
async function pdf(label: string) {
  const doc = await PDFDocument.create(); const page = doc.addPage();
  page.drawText(`SYNTHETIC ONLY - ${label}`, { x: 40, y: 750, size: 20, font: await doc.embedFont(StandardFonts.Helvetica) });
  const bytes = await doc.save(); writeFileSync(path.join(scratch, `${label}.pdf`), bytes); return bytes;
}
const pdfBytes = await pdf("first-payslip");
await pdf("second-payslip"); await pdf("replacement-payslip"); await pdf("contract");
const file = (type = "payslip", extra = {}) => ({ clientId: randomUUID(), documentType: type, name: `${type}.pdf`, type: "application/pdf", size: pdfBytes.length, sha256: createHash("sha256").update(pdfBytes).digest("hex"), ...(type === "payslip" ? { periodMonth: "2026-08" } : {}), ...extra });
async function post(caseId: string, route: string, body: unknown, expected = 200) {
  const response = await fetch(`${origin}/api/documents/${route}`, { method: "POST", headers: { "content-type": "application/json", origin, cookie: `tivdoc_salary_case=${caseCookie(caseId)}` }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.ok(text, `${route} returned empty response, status ${response.status}`);
  const json = JSON.parse(text);
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(json)}`);
  return json;
}
async function upload(caseId: string, files: ReturnType<typeof file>[], extra = {}) {
  const body = { caseId, batchId: randomUUID(), files, ...extra };
  const signed = await post(caseId, "sign", body);
  for (const item of signed.uploads) {
    if (item.uploaded) continue;
    const put = await fetch(item.signedUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: pdfBytes });
    assert.ok(put.ok, `PUT status ${put.status}`);
  }
  return { body, signed };
}
try {
  const main = await seed(); const other = await seed();
  identityId = (await client.query("select public.case_access_identity_upsert('email',$1,$2) id", [createHash("sha256").update(main.id).digest("hex"), `upload-${main.id}@example.invalid`])).rows[0].id;
  await client.query("select public.case_access_identity_link($1,$2)", [identityId, main.id]);
  await client.query("select public.case_access_session_create($1,$2,3600)", [identityId, hashSession(session)]);
  server = startServer(productionBuild ? "production" : "dev", environment, port);
  assert.ok(await waitForServer(port, 60_000), "Next server did not start");
  const initial = await upload(main.id, [file(), file("contract")]);
  const first = await post(main.id, "complete", { caseId: main.id, batchId: initial.body.batchId });
  const before = (await client.query("select id,storage_path,version_id from public.documents where case_id=$1 order by slot", [main.id])).rows;
  const second = await upload(main.id, [file()]);
  const added = await post(main.id, "complete", { caseId: main.id, batchId: second.body.batchId });
  assert.equal(added.documents.length, 3);
  for (const previous of before) {
    const stored = await storage.download(previous.storage_path); assert.ifError(stored.error);
    assert.deepEqual(new Uint8Array(await stored.data!.arrayBuffer()), pdfBytes);
  }
  check("HTTP + real Storage: second payslip preserves first payslip and contract bytes");
  const target = first.documents.find((doc: { document_type: string }) => doc.document_type === "payslip");
  const replacement = await upload(main.id, [file("payslip", { name: "replacement.pdf", replace: { documentId: target.id, versionId: target.version_id } })]);
  const stillOld = (await client.query("select storage_path from public.documents where id=$1", [target.id])).rows[0].storage_path;
  assert.equal(stillOld, before.find((doc) => doc.id === target.id).storage_path);
  const replaceDone = await post(main.id, "complete", { caseId: main.id, batchId: replacement.body.batchId });
  assert.equal(replaceDone.documents.length, 3); assert.equal(replaceDone.status, "under_review"); assert.equal(replaceDone.paymentStatus, "verified");
  assert.ifError((await storage.download(stillOld)).error);
  check("explicit HTTP replacement retains previous bytes before and after commit");
  const repeatPut = await fetch(replacement.signed.uploads[0].signedUrl, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "true" }, body: pdfBytes });
  assert.equal(repeatPut.ok, false);
  check("signed token rejects replay overwrite even with forged x-upsert header");
  const foreignUrl = replacement.signed.uploads[0].signedUrl.replace(main.id, other.id);
  assert.notEqual(foreignUrl, replacement.signed.uploads[0].signedUrl);
  assert.equal((await fetch(foreignUrl, { method: "PUT", headers: { "content-type": "application/pdf" }, body: pdfBytes })).ok, false);
  check("Storage token cannot be reused for a different case path");
  const retry = await post(main.id, "sign", replacement.body);
  assert.equal(retry.completed, true);
  assert.equal((await post(main.id, "complete", { caseId: main.id, batchId: replacement.body.batchId })).documents.length, 3);
  check("HTTP sign and completion retries publish once");
  const lost = await upload(main.id, [file()]);
  const resume = await post(main.id, "sign", lost.body);
  assert.equal(resume.uploads[0].uploaded, true);
  await post(main.id, "complete", { caseId: main.id, batchId: lost.body.batchId });
  check("lost PUT response resumes from actual stored object");
  await post(main.id, "complete", { caseId: other.id, batchId: lost.body.batchId }, 403);
  await post(other.id, "complete", { caseId: other.id, batchId: lost.body.batchId }, 403);
  check("HTTP cross-case page/cookie and batch references both rejected");
  const partialBody = { caseId: main.id, batchId: randomUUID(), files: [file()] };
  await post(main.id, "sign", partialBody);
  await post(main.id, "complete", { caseId: main.id, batchId: partialBody.batchId }, 503);
  await post(main.id, "complete", { caseId: main.id, batchId: partialBody.batchId, action: "cancel" });
  assert.ifError((await storage.download(stillOld)).error);
  check("incomplete transfer cannot publish or remove saved bytes");
  const payslipOnly = await upload(other.id, [file()]);
  await post(other.id, "complete", { caseId: other.id, batchId: payslipOnly.body.batchId });
  const request = (await runtimeDb.query("insert into public.case_requests(case_id,code,question,answer_kind,blocking,expires_at) values($1,'contract_missing','Synthetic contract request','document',true,now()+interval '10 days') returning id", [other.id])).rows[0].id;
  const contract = await upload(other.id, [file("contract")], { requestId: request });
  const late = await post(other.id, "complete", { caseId: other.id, batchId: contract.body.batchId });
  assert.equal(late.documents.length, 2); assert.equal(late.status, "under_review"); assert.equal(late.paymentStatus, "verified");
  assert.ok((await runtimeDb.query("select answered_at from public.case_requests where id=$1", [request])).rows[0].answered_at);
  check("HTTP contract-only completion with real stored payslip answers selected request without resetting payment");
  const parallel = await Promise.all([upload(main.id, [file()]), upload(main.id, [file()])]);
  await Promise.all(parallel.map((item) => post(main.id, "complete", { caseId: main.id, batchId: item.body.batchId })));
  const slots = (await client.query("select slot from public.documents where case_id=$1", [main.id])).rows;
  assert.equal(new Set(slots.map((row) => row.slot)).size, slots.length);
  check("parallel HTTP sign/PUT/complete requests preserve distinct document slots");
  const form = await fetch(`${origin}/check/upload`, { headers: { cookie: `tivdoc_salary_case=${caseCookie(main.id)}` } });
  const html = await form.text(); assert.equal(form.status, 200); assert.ok(html.includes("replacement.pdf")); assert.ok(html.includes("contract.pdf"));
  check("real upload page renders persisted documents on return");
  writeFileSync(path.join(scratch, "browser-state.json"), JSON.stringify({ origin, caseId: main.id, publicId: main.public_id,
    cookies: [{ name: "tivdoc_salary_case", value: caseCookie(main.id), url: origin, httpOnly: true, sameSite: "Lax" }, { name: "tivdoc_case_session", value: session, url: origin, httpOnly: true, sameSite: "Lax" }] }));
  console.log(JSON.stringify({ passed, origin, scratch, readyForBrowser: process.argv.includes("--hold") }));
  if (process.argv.includes("--hold")) {
    const deadline = Date.now() + 30 * 60_000;
    while (!existsSync(stopFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  server?.server.kill("SIGTERM");
  if (server) writeFileSync(path.join(scratch, "server.log"), server.log.join(""));
  // Explicitly delete only this proof's random case namespaces, after the server stops.
  for (const caseId of cases) {
    const paths = new Set<string>();
    for (const row of (await runtimeDb.query("select storage_path from public.documents where case_id=$1 union select storage_path from public.document_versions where case_id=$1", [caseId])).rows) paths.add(row.storage_path);
    for (const row of (await runtimeDb.query("select files from public.document_upload_batches where case_id=$1", [caseId])).rows) for (const f of row.files) paths.add(f.path);
    for (const object of paths) assert.ok(object.startsWith(`cases/${caseId}/versions/`));
    if (paths.size) { const result = await storage.remove([...paths]); assert.ifError(result.error); }
    await client.query("delete from public.cases where id=$1", [caseId]);
  }
  if (identityId) await client.query("delete from public.case_identities where id=$1", [identityId]);
  await client.end();
  await runtimeDb.end();
  rmSync(path.join(scratch, "browser-state.json"), { force: true });
  console.log("Synthetic proof cases, identity and Storage objects removed.");
}
