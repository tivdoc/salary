import {expect, it, vi} from 'vitest';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb} from '../case-access/db';
import {resendProvider} from '../case-access/resend-provider';
import {DOCUMENT_FIELD_CONFIRMATION_ANSWERS, documentFieldTarget, documentFieldTargetSchema} from '../reports/document-field-confirmation';
import {runAutomaticNotificationPass} from './automatic-dev-notifications';
import {admitSavedSource} from './saved-admission';
import {dispatchCaseInput, sourceJobSchema} from './source-dispatch';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
vi.mock('server-only', () => ({}));

const CASE = '87eb4418-7d9f-4b68-aa86-82be059295ac';
const REQUEST = '59aa4632-0d35-47b2-b62d-4e744e79417b';
const VERSION = '2c9f4382-734a-42ba-9f17-ceb427acc836';
const APP_SHA = 'a30f881dca092bbec91cb48aae7fdfc670d0ee5f';
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const read = (filename: string) => JSON.parse(readFileSync(filename, 'utf8')) as unknown;

/** An opt-in continuation of an existing FAIL receipt. No OCR call, customer
 * session, OTP, report or source is seeded. Only an explicitly scoped machine
 * authorization is provisioned; the browser must submit the actual answer. */
it.skipIf(process.env.TIVDOC_RETAINED_LIVE_NOTIFICATION_PROOF !== '1')('delivers one retained current-source request and observes an identified browser answer without stale report publication', async () => {
  if (process.env.VERCEL || process.env.NODE_ENV !== 'test') throw Error('RETAINED_NOTIFICATION_DEV_ONLY');
  const proofFile = z.string().min(1).parse(process.env.TIVDOC_RETAINED_LIVE_SOURCE_PROOF);
  const ownedFile = z.string().min(1).parse(process.env.TIVDOC_RETAINED_LIVE_OWNED_MANIFEST);
  const previewFile = z.string().min(1).parse(process.env.TIVDOC_RETAINED_LIVE_PREVIEW_FILE);
  const directory = path.resolve(`output/release-completion/dev-financial-live-flow/${CASE}`);
  expect(path.resolve(proofFile)).toBe(path.join(directory, 'live-financial-db-proof.json'));
  expect(path.resolve(ownedFile)).toBe(path.resolve(`../release-work/dev-financial-live-owned-${CASE}.json`));
  const sourceProof = z.object({verdict: z.literal('FAIL'), gitSha: z.literal(APP_SHA), retainedForOwnerBrowser: z.literal(true), retainedCaseId: z.literal(CASE),
    retainedPublicId: z.literal('TV-73299C08'), runs: z.array(z.object({runId: z.uuid(), inputRevision: z.number(), state: z.string()})).min(1)}).parse(read(proofFile));
  const manifest = z.object({retained: z.literal(true), gitSha: z.literal(APP_SHA), directory: z.string(), notificationCapabilitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    cases: z.array(z.object({id: z.uuid(), publicId: z.string(), identity: z.uuid(), sid: z.string(), orderId: z.uuid()}))}).parse(read(ownedFile));
  expect(path.resolve(manifest.directory)).toBe(directory);
  const retained = manifest.cases.find(value => value.id === CASE)!;
  expect(retained?.publicId).toBe(sourceProof.retainedPublicId);
  const preview = z.object({id: z.string(), url: z.string(), target: z.literal('preview'), readyState: z.literal('READY'), sha: z.literal(APP_SHA)}).parse(read(previewFile));
  const origin = new URL('https://' + preview.url); expect(origin.hostname.endsWith('.vercel.app')).toBe(true);
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  expect(execFileSync('git', ['status', '--porcelain'], {encoding: 'utf8'}).trim()).toBe('');
  const changed = execFileSync('git', ['diff', '--name-only', APP_SHA, gitSha, '--', 'src', 'scripts/product-workers', 'supabase/migrations', 'package.json', 'package-lock.json', 'next.config.ts', 'vercel.json'], {encoding: 'utf8'}).trim().split(/\r?\n/u).filter(Boolean);
  expect(changed.filter(file => !file.endsWith('.test.ts') && !file.endsWith('.test.mts') && !file.endsWith('.test.tsx'))).toEqual([]);
  const ownerEmail = z.object({verifiedBy: z.literal('explicit owner authorization'), allowlist: z.tuple([z.email()])})
    .parse(read(process.env.TIVDOC_DEV_OWNER_RECIPIENT_FILE ?? '../release-work/dev-owner-recipient.json')).allowlist[0].trim().toLowerCase();
  const contactHash = sha('email|' + ownerEmail), secret = process.env.TIVDOC_NOTIFICATION_ENCRYPTION_KEY;
  if (process.env.TIVDOC_NOTIFICATION_PROVIDER !== 'resend' || !process.env.RESEND_API_KEY || !process.env.TIVDOC_NOTIFICATION_FROM
    || !secret || Buffer.from(secret, 'base64').length !== 32 || process.env.DELIVERY_RECIPIENT_ALLOWLIST?.trim() !== ownerEmail) throw Error('RETAINED_NOTIFICATION_CONFIGURATION');
  const {readDevEnvFile} = await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'), env = readDevEnvFile();
  const client = (key: string) => {const u = new URL(env.get(key)!); expect(u.pathname).toBe('/tivdoc_release_replay_20260907');
    expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com'); expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true); u.search = '';
    return new pg.Client({connectionString: u.toString(), ssl: {rejectUnauthorized: true, ca: SUPABASE_ROOT_2021_CA}, connectionTimeoutMillis: 15000, statement_timeout: 15000});};
  const owner = client('TIVDOC_DEV_DATABASE_URL'), worker = client('TIVDOC_WORKER_POSTGRES_URL'), web = client('TIVDOC_WEB_POSTGRES_URL');
  const capability = randomBytes(32).toString('base64url'), capabilitySha = sha(capability), sid = `retained-notification:${randomUUID()}`, jti = randomUUID();
  const proofId = randomUUID(), output = path.join(directory, 'retained-notification', proofId);
  mkdirSync(output, {recursive: true});
  const evidence: Record<string, unknown> = {proofId, sourceReceiptSha256: sha(readFileSync(proofFile)), ownedManifestSha256: sha(readFileSync(ownedFile)),
    applicationGitSha: APP_SHA, driverGitSha: gitSha, applicationDiff: changed, preview, caseId: CASE, requestId: REQUEST,
    originalFullFlowVerdict: 'FAIL', originalFailureUnchanged: true, noOcrCalls: true, noSeededReport: true, noCustomerSessionCreated: true};
  const checks: string[] = []; let enrolled = false, cleaned = false, passed = false, phase = 'connect';
  let providerId: string | undefined, browserObserved = false, delivered = false, newJob: unknown = null, reportReadyCount: number | null = null;
  const save = () => writeFileSync(path.join(output, 'proof.json'), JSON.stringify({...evidence, checks, phase, verdict: passed && cleaned ? 'PASS' : 'FAIL',
    checkedAt: new Date().toISOString(), providerId, providerDeliveryVerified: delivered, identifiedAnswerObserved: browserObserved, newJob,
    cleanupVerified: cleaned, canonicalBlockedReplayProved: false, currentFinancialReportCreated: false, observedReportReadyOutboxCount: reportReadyCount,
    browserActionIndependentlyVerified: false,
    remainingBlock: 'Current source still lacks salary_type/base candidates; canonical replay and a new financial report are not proven by this driver.', productionChanged: false}, null, 2) + '\n');
  const head = async () => (await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1', [CASE])).rows[0];
  const answers = async () => (await owner.query('select revision,identity_id,answer_text,origin from private.case_request_answer_versions where request_id=$1 order by revision', [REQUEST])).rows;
  const noPending = async () => {const rows = (await owner.query("select delivery_id from private.case_notification_outbox where recipient_sha256=$1 and (case_id=$2 or case_id is null) and state in ('queued','leased') and expires_at>clock_timestamp()", [contactHash, CASE])).rows;
    if (rows.length) throw Error('RETAINED_UNRELATED_PENDING_NOTIFICATION');};
  try {
    await Promise.all([owner.connect(), worker.connect(), web.connect()]);
    expect((await owner.query('select session_user principal,current_database() database')).rows[0]).toEqual({principal: 'tivdoc_dev_migrator', database: 'tivdoc_release_replay_20260907'});
    phase = 'verify-retained-source';
    const owned = (await owner.query(`select c.public_id,c.is_qa,c.first_name,c.status,c.payment_status,c.contact_verified_at,i.contact_hash,m.identity_id,m.session_sid,m.capability_sha256,b.enabled old_capability_enabled
      from public.cases c join public.case_identity_cases ic on ic.case_id=c.id join public.case_identities i on i.id=ic.identity_id
      join private.managed_dev_worker_cases m on m.case_id=c.id and m.identity_id=i.id join private.managed_dev_worker_capabilities b on b.capability_sha256=m.capability_sha256
      where c.id=$1 and i.id=$2`, [CASE, retained.identity])).rows;
    expect(owned).toHaveLength(1); expect(owned[0]).toMatchObject({public_id: retained.publicId, is_qa: true, first_name: 'Synthetic DEV live financial flow', status: 'under_review', payment_status: 'verified',
      contact_hash: contactHash, identity_id: retained.identity, session_sid: retained.sid, capability_sha256: manifest.notificationCapabilitySha256, old_capability_enabled: false});
    expect(owned[0].contact_verified_at).not.toBeNull();
    const targetRow = (await owner.query(`select t.target,r.code,r.answered_at,r.expires_at>clock_timestamp() unexpired,private.document_field_current(t.case_id,t.target) current
      from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id where t.case_id=$1 and t.request_id=$2`, [CASE, REQUEST])).rows[0];
    const target = documentFieldTargetSchema.parse(targetRow?.target);
    expect(targetRow).toMatchObject({code: `document_field:${target.target_sha256}`, answered_at: null, unexpired: true, current: true});
    expect(target).toMatchObject({case_id: CASE, version_id: VERSION, month: '2026-06', candidate: {field: 'gross_salary', normalized_value: {currency: 'ILS', minor_units: 330000}}});
    const current = await head();
    const checkpointRow = (await owner.query(`select c.result,c.result_sha256,d.content_sha256,d.id document_id from private.case_extraction_checkpoints c
      join public.documents d on d.case_id=c.case_id and d.version_id=c.version_id where c.case_id=$1 and c.revision=$2 and c.version_id=$3 and c.policy_version=$4`, [CASE, current.revision, VERSION, SAVED_EXTRACTION_POLICY])).rows[0];
    expect(checkpointRow?.result_sha256).toBe(target.extraction_result_sha256); expect(checkpointRow?.content_sha256).toBe(target.source_sha256);
    expect(canonicalSha256(checkpointRow.result.run.result)).toBe(target.extraction_result_sha256);
    expect(documentFieldTarget({checkpoint: checkpointRow.result, policyVersion: SAVED_EXTRACTION_POLICY, candidateId: target.candidate.candidate_id})).toEqual(target);
    expect(checkpointRow.result).toEqual(read(path.join(directory, 'missing-extraction.json'))); expect(await answers()).toEqual([]);
    const oldRun = sourceProof.runs.find(value => value.state === 'calculated')!; expect(oldRun).toBeTruthy();
    const historical = (await owner.query('select id,input_revision,input_sha256,payload_sha256 from private.dev_financial_runs where id=$1 and case_id=$2', [oldRun.runId, CASE])).rows[0];
    expect(historical).toBeTruthy(); expect(historical.input_revision).toBeLessThan(current.revision);
    const oldJobs = (await owner.query('select job_id,state,revision,cancellation_requested from public.engine_durable_jobs where canonical_case_id=$1 order by job_id', [CASE])).rows;
    evidence.initialHead = current; evidence.historicalRun = historical; evidence.sourceVersion = VERSION; evidence.checkpointSha256 = target.extraction_result_sha256;
    await noPending();
    phase = 'enroll-notification-only';
    // Private recovery file contains only identifiers/hashes, never the capability,
    // API key, encryption key or a customer credential.
    writeFileSync(`../release-work/retained-notification-owned-${proofId}.json`, JSON.stringify({caseId: CASE, sid, capabilitySha256: capabilitySha, output, driverGitSha: gitSha}, null, 2));
    await owner.query('begin');
    const locked = (await owner.query(`select m.capability_sha256,m.session_sid,b.enabled from private.managed_dev_worker_cases m
      join private.managed_dev_worker_capabilities b on b.capability_sha256=m.capability_sha256 where m.case_id=$1 for update of m,b`, [CASE])).rows[0];
    expect(locked).toMatchObject({capability_sha256: manifest.notificationCapabilitySha256, session_sid: retained.sid, enabled: false});
    await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'retained.dev.notification.proof',$3,now()-interval '1 second',now()+interval '30 minutes',$4,now())", [`saved-case:${CASE}`, sid, jti, canonicalSha256({sid, jti})]);
    await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,daily_limit,total_limit,notification_recipients) values($1,clock_timestamp()+interval '30 minutes',1,1,$2::text[])", [capabilitySha, [contactHash]]);
    expect((await owner.query('update private.managed_dev_worker_cases set capability_sha256=$1,session_sid=$2,enabled=true where case_id=$3 and identity_id=$4 and capability_sha256=$5 and session_sid=$6', [capabilitySha, sid, CASE, retained.identity, manifest.notificationCapabilitySha256, retained.sid])).rowCount).toBe(1);
    await owner.query('commit'); enrolled = true;
    const db = postgresCaseAccessDb({query: (sql, values) => worker.query(sql, values ? [...values] : [])});
    const notify = (event: string) => runAutomaticNotificationPass({db, capability, secret, origin: origin.origin, provider: resendProvider(process.env.RESEND_API_KEY!, process.env.TIVDOC_NOTIFICATION_FROM!), enqueueEventKeys: [event]});
    phase = 'stale-report-refusal';
    const staleKey = 'engineering:' + oldRun.runId;
    expect(await notify(staleKey)).toMatchObject({queued: 0, attempts: [], deliveryConfirmed: false});
    expect((await owner.query('select count(*)::int n from private.managed_dev_notification_events where event_key=$1', [staleKey])).rows[0].n).toBe(0);
    checks.push('The genuine historical financial report is refused as a current report event after source replacement.');
    phase = 'live-request-delivery'; await noPending();
    const result = await notify('request:' + REQUEST); expect(result.queued).toBe(1); expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({state: 'provider_accepted', provider: 'resend'}); providerId = z.uuid().parse(result.attempts[0].provider_message_id);
    evidence.providerAcceptance = result; save();
    await noPending(); expect(await notify('request:' + REQUEST)).toMatchObject({queued: 0, attempts: []});
    let delivery: Record<string, unknown> | undefined;
    for (let tick = 0; tick < 20; tick++) {delivery = (await owner.query('select delivery_id,state,provider_message_id,delivered_at,encrypted_payload is null payload_cleared from private.case_notification_outbox where provider_message_id=$1 and case_id=$2 and identity_id=$3', [providerId, CASE, retained.identity])).rows[0]; if (delivery?.state === 'delivered') break; await delay(1000);}
    const events = (await owner.query('select event_id,kind,occurred_at,received_at from private.case_notification_webhooks where provider_message_id=$1 order by occurred_at', [providerId])).rows;
    evidence.delivery = delivery; evidence.webhooks = events;
    expect(delivery).toMatchObject({state: 'delivered', payload_cleared: true}); expect(events.some(value => value.kind === 'email.delivered')).toBe(true); delivered = true;
    checks.push('One authentic current gross-field request was sent by actual Resend; the authenticated webhook updated the encrypted outbox to delivered. Retry sent no second email.');
    phase = 'browser-answer-pending'; save();
    writeFileSync(path.join(output, 'browser-answer-pending.json'), JSON.stringify({publicId: retained.publicId, requestId: REQUEST, expectedAnswer: DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0], preview, driverGitSha: gitSha}, null, 2));
    console.log('RETAINED_LIVE_BROWSER_ANSWER_PENDING', retained.publicId, REQUEST);
    let accepted: Awaited<ReturnType<typeof answers>> = [];
    for (let tick = 0; tick < 300; tick++) {accepted = await answers(); if (accepted.length) break; await delay(1000);}
    expect(accepted).toHaveLength(1); expect(accepted[0]).toMatchObject({revision: 1, identity_id: retained.identity, answer_text: DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]});
    browserObserved = true; evidence.answer = accepted[0];
    await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)', [REQUEST, CASE, retained.identity, DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);
    expect(await answers()).toEqual(accepted); await noPending(); expect(await notify('request:' + REQUEST)).toMatchObject({queued: 0, attempts: []});
    phase = 'new-input-dispatch';
    const after = await head(); expect(after.revision).toBeGreaterThan(current.revision); expect(after.input_sha256).not.toBe(current.input_sha256);
    const job = sourceJobSchema.parse({schema_version: 'saved-case-work-v1', case_id: CASE, ...after, mode: 'draft'});
    await worker.query('begin'); await worker.query('select * from private.runtime_context_install($1,$2,$3)', [sid, jti, 'retained-live-notification-proof']);
    const context: PostgresTransactionContext = {transaction_id: randomUUID(), client: {async query(statement) {const rows = await worker.query(statement.text, [...statement.values]); return {rows: rows.rows, row_count: rows.rowCount ?? 0};}}};
    await admitSavedSource(context, job);
    newJob = await dispatchCaseInput(context, {caseId: CASE, tenantId: `saved-case:${CASE}`, mode: 'draft', liveEnabled: false, nowMs: Date.now()});
    expect(newJob).not.toBeNull(); await worker.query('commit');
    evidence.answeredHead = after;
    expect((await owner.query('select job_id,state,revision,cancellation_requested from public.engine_durable_jobs where job_id=any($1::text[]) order by job_id', [oldJobs.map(value => value.job_id)])).rows).toEqual(oldJobs);
    expect((await owner.query('select version_id,content_sha256 from public.documents where id=$1 and case_id=$2', [target.product_document_id, CASE])).rows[0]).toEqual({version_id: VERSION, content_sha256: target.source_sha256});
    expect((await owner.query('select id,input_revision,input_sha256,payload_sha256 from private.dev_financial_runs where case_id=$1 order by id', [CASE])).rows).toEqual([historical]);
    reportReadyCount = z.number().int().parse((await owner.query('select count(*)::int n from private.case_notification_outbox where case_id=$1 and template=$2', [CASE, 'report_ready'])).rows[0].n);
    expect(reportReadyCount).toBe(0);
    checks.push('An identified answer creates one answer revision and a new input/dispatch job; its retry is idempotent. Cancelled old jobs, current source and the historical report remain unchanged. No new financial report is claimed.');
    phase = 'complete'; passed = true;
  } catch (error) {
    evidence.failure = {phase, kind: error instanceof Error ? error.name : 'unknown', code: error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message) ? error.message : null};
    throw Error('RETAINED_LIVE_NOTIFICATION_PROOF_FAILED');
  } finally {
    await Promise.all([owner, worker, web].map(connection => connection.query('rollback').catch(() => {})));
    try {
      if (enrolled) {await owner.query('begin');
        expect((await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1', [capabilitySha])).rowCount).toBe(1);
        expect((await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2 and current_jti=$3', [`saved-case:${CASE}`, sid, jti])).rowCount).toBe(1);
        expect((await owner.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=clock_timestamp() where case_id=$1 and capability_sha256=$2 and session_sid=$3', [CASE, capabilitySha, sid])).rowCount).toBe(1);
        await owner.query('commit'); cleaned = true;
      }
    } catch {await owner.query('rollback').catch(() => {}); evidence.cleanupFailure = 'OWNED_NOTIFICATION_AUTHORIZATION_CLEANUP_FAILED'; throw Error('RETAINED_NOTIFICATION_CLEANUP_FAILED');}
    finally {save(); await Promise.all([owner.end(), worker.end(), web.end()]);}
  }
}, 8 * 60 * 1000);
