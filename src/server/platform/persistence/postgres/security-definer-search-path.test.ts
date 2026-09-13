import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Wave 3 (C2). The half of the SECURITY DEFINER contract that migration text
// can settle on its own.
//
// Whether a definer function is *gated* is a property of the live schema —
// ownership, policies, and which roles those policies bind — and is asserted by
// `scripts/legal-review-projection/secdef-surface-matrix.mts` against DEV,
// because three separate attempts to answer it from source shapes produced
// three different wrong counts. What source text does settle exactly is the
// search_path: a definer function without a pinned empty search_path resolves
// unqualified names through whatever the caller put in front of it, which turns
// every bare identifier in the body into a hook. There is no case where that is
// acceptable, so there is no allowlist here.

const MIGRATION_ROOT = path.resolve(process.cwd(), "supabase", "migrations");

/** Definition count, not distinct names: `create or replace` redefines. */
// Run 11 / L11-2: 154 -> 158. Migration 202609020031 declares three definers (the
// resolution guard, record and read) and 202609020032 re-declares the record
// function in place; each declaration counts.
// External review #1, finding 5: 158 -> 161. Migration 202609050004 re-declares the record
// function and the read function (dropped and created, its return type changed), and
// 202609050005 re-declares the record function once more (the audit-actor repair).
// Release P05–P12: explicit additional source, request, delivery, order, privacy and metrics definitions.
// See docs/release-evidence/P12-definer-surface.json; the empty search_path rule remains exhaustive.
// P13 real owner upload exposed the request-close trigger's missing authority.
// The new trigger-only definer has no runtime EXECUTE grant and binds order/case.
// P09 internal quote context and credit reservation: verified worker/case only.
// Customer cancellation: private customer boundary plus two existing function redeclarations.
// Automatic DEV125–127: eight registry/claim/draft definers, five notification
// and capability definitions, then one snapshot-bound enqueue replacement.
// All14 are reviewed against the exact DEV/role/recipient gates and exhaustive
// empty-search-path assertion below; no function or migration is excluded.
// June collection128–130: current-source predicate and answer trigger are
// internal-only; request opening is verified-worker-only; state reads use the
// existing identified web/service boundary. Four new definitions, all covered
// by the exhaustive assertion and the actual DEV ACL receipt in the handoff.
// The forward migrations replace existing function bodies and retain ACLs.
// Direct Resend receipts131: two new functions and two redeclarations.
// Actual DEV ACL, collision and lock-order probes cover the live permissions.
// Source completions132–134 add four request/current/answer/state boundaries
// and one internal-only financial checkpoint/journal binding. Actual DEV
// upgrade and ACL probes retain the same restrictive source and actor gates.
//135 redeclares the same internal binding to disambiguate its local variable;
// JSON paths, predicates, empty search_path and existing ACLs are unchanged.
//136 adds three isolated DEV canonical assessment/save/customer boundaries.
//139–141 add seven authority, identified-hours and ordinary report boundaries.
// Their DEV ACL receipt denies direct authority/result writes to every runtime.
//144 adds a private current-authority predicate and its case/identity-bound snapshot wrapper.
//149 adds one capability-scoped QA health read; no authority/source payload.
//150 adds worker admit/open, identified-answer guard and owned UI metadata.
//158 adds four internal completion-round helpers and three worker-only API
// boundaries. Exact names/ACL groups are inventoried below; source review is
// recorded in docs/release-evidence/managed-completion-definer-review-20260911.md.
//159 adds five reviewed source-review boundaries. No direct target writes;
// worker-only open/history, internal currentness/guard, identity-bound UI state.
// See docs/release-evidence/document-review-definer-review-20260911.md.
//160–166: 32 literal declarations (2+2+22+3+2+0+1), including redeclarations.
// Dynamic pg_get_functiondef body replacements are separately inventoried below;
// they preserve existing ownership/ACL and do not add declarations to this count.
// See docs/release-evidence/product-upload-definer-review-20260911.md.
//167 adds two worker-only prompt-derivation evidence boundaries. The original
// checkpoint remains immutable; no catalog, payment or publication grant.
//168 patches only that put body's locked QA check; no additional declaration.
//169 redeclares the current-source predicate, worker opener and protected source
// lookup. Their OIDs/ACLs are retained; the new scope helper is security invoker.
//171-177: one currentness redeclaration, four profile/dependency helpers,
//one worker finding recorder and one retained-source receipt loader. The
//owner enrollment RPC is security invoker; exact grants are inventoried below.
//181 adds the scoped owner engineering recorder; no customer publication grant.
//185–188: seven literal declarations (4+1+1+1), reviewed by name below.
// Captured wrappers retain their prior ACLs and are inventoried separately;
// the period metadata branch adds no new runtime authority or answer store.
//191 adds22 literal declarations. Source-intake scope/answer/physical metadata
// and finalizer helpers preserve original paid receipts; see the exact inventory
// below and the isolated DEV upgrade/ACL evidence. No function is excluded.
//193 redeclares only the same scoped request opener to disambiguate a local
// variable. Both answer validators are private security invoker functions.
//194 extends the existing receipt-scoped upload capture, without new grants.
//195–197:11 source/choice guards;198:5 REAL routing/context boundaries.
//198 runtime ACL rollback audit:72 checks, worker gets only two authenticated reads.
//199:11 delivery/read/notice boundaries;200:2 purchase boundaries;201:6 source-reading
//boundaries;202:1 worker notice preparation;203:0 literal definers, exact wrappers retain ACLs.
//DEV rollback checks preserve public source ACLs and deny all seven runtime roles on backups.
//204:5 explicit activation/controller/dependency definitions;77 DEV ACL checks.
//205–206:2 literal definitions, derived wrappers retain existing scoped bodies;
//112 DEV ACL checks permit only the identity issuer and two worker successor RPCs.
//207–208: six controller/claim/maintenance/provider RPCs; private helpers remain
//invoker-only. DEV rollback verified70 function ACLs and28 table/RLS boundaries.
//209/211 add two narrow worker discovery RPCs.210 changes only capability regex
//in four existing definitions while asserting unchanged ACLs; no new definer.
const EXPECTED_SECURITY_DEFINER_DEFINITIONS = 456;

// Case-insensitive on purpose. pg_get_functiondef emits CREATE OR REPLACE
// FUNCTION and SET search_path TO '' in upper case, and a migration written
// from a verbatim DEV body was invisible to both the count and the search_path
// check until this was noticed — two definer definitions arrived uncounted.
// The body delimiter is `$$` in hand-written migrations and `$function$` in
// pg_get_functiondef output; either is a dollar-quoted body.
const DEFINITION = /create\s+(?:or\s+replace\s+)?function\s+((?:public|private)\.[a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns([\s\S]*?)\bas\s+\$[a-z_]*\$/giu;
const PINNED_EMPTY_SEARCH_PATH = /set\s+search_path\s*(?:=|\bto\b)\s*(?:''|"")/iu;

type Definition = Readonly<{ file: string; name: string; header: string }>;

async function securityDefinerDefinitions(): Promise<readonly Definition[]> {
  const files = (await readdir(MIGRATION_ROOT)).filter((name) => name.endsWith(".sql")).sort();
  const found: Definition[] = [];
  for (const file of files) {
    const sql = (await readFile(path.join(MIGRATION_ROOT, file), "utf8")).replaceAll("\r\n", "\n");
    for (const match of sql.matchAll(DEFINITION)) {
      const header = match[3] as string;
      if (!/security\s+definer/iu.test(header)) continue;
      found.push({ file, name: match[1] as string, header });
    }
  }
  return found;
}

// Reviewed names and complete explicit EXECUTE-grant sets, including invoker
// helpers. This is an intentional migration inventory, not an inferred ACL audit.
const PRODUCT_UPLOAD_SURFACE = [
  {
    "file": "20260911164033_identified_cell_reading_v2.sql",
    "definers": [
      "private.guard_document_cell_decision",
      "public.case_request_field_reading_targets"
    ],
    "grants": [
      "private.document_field_answer_v2_valid(text) to service_role,tivdoc_web_runtime",
      "public.case_request_field_reading_targets(uuid,uuid) to tivdoc_web_runtime,service_role",
      "private.document_field_question_fields_v3(text[]) to tivdoc_worker_runtime"
    ],
    "dynamic": []
  },
  {
    "file": "20260911164425_private_document_review_artifacts.sql",
    "definers": [
      "public.case_report_private_review_list",
      "public.case_report_private_review_artifact"
    ],
    "grants": [
      "public.case_report_private_review_list(uuid,uuid) to tivdoc_web_runtime",
      "public.case_report_private_review_artifact(uuid,uuid,uuid) to tivdoc_web_runtime"
    ],
    "dynamic": []
  },
  {
    "file": "20260911165540_legacy_paid_review_upload_flow.sql",
    "definers": [
      "private.legacy_paid_scopes_internal",
      "private.legacy_paid_scopes",
      "private.legacy_paid_scope_register",
      "private.legacy_paid_period_register",
      "private.legacy_paid_scope_revoke",
      "private.document_review_upload_validate",
      "private.document_review_upload_bind",
      "private.document_review_upload_commit_guard",
      "private.document_review_upload_received",
      "private.document_review_upload_pin_current",
      "private.document_review_upload_batch_scope",
      "private.document_review_upload_snapshot",
      "private.document_review_upload_journal",
      "private.document_review_upload_capture",
      "private.document_review_paid_scope_current",
      "private.document_review_scope_insert_guard",
      "private.document_field_request_open",
      "public.case_order_legacy_receipts",
      "private.document_review_upload_assess",
      "private.document_review_upload_state",
      "private.document_review_upload_assessment_inputs",
      "public.case_request_review_upload_states"
    ],
    "grants": [
      "private.legacy_paid_scopes(uuid) to tivdoc_worker_runtime",
      "private.legacy_paid_scope_register(uuid,bytea,jsonb) to tivdoc_operations_runtime",
      "private.legacy_paid_period_register(uuid,jsonb) to tivdoc_operations_runtime",
      "private.legacy_paid_scope_revoke(uuid,uuid,text,text) to tivdoc_operations_runtime",
      "private.document_review_upload_validate(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role",
      "private.document_review_upload_bind(uuid,uuid) to tivdoc_web_runtime,service_role",
      "private.document_review_upload_commit_guard(uuid,uuid) to tivdoc_web_runtime,service_role",
      "private.document_review_upload_received(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role",
      "private.document_review_upload_batch_scope(uuid,uuid) to service_role,tivdoc_web_runtime",
      "private.document_review_upload_snapshot(uuid,jsonb) to service_role,tivdoc_web_runtime",
      "private.document_review_upload_capture(uuid,uuid) to service_role,tivdoc_web_runtime",
      "private.document_field_request_open(uuid,integer,text,jsonb,text) to tivdoc_worker_runtime",
      "public.case_order_legacy_receipts(uuid,uuid) to tivdoc_web_runtime,service_role",
      "private.document_review_upload_assess(uuid,integer,text,uuid,text,text) to tivdoc_worker_runtime",
      "private.document_review_upload_assessment_inputs(uuid,integer,text,text,text) to tivdoc_worker_runtime",
      "public.case_request_review_upload_states(uuid,uuid) to service_role,tivdoc_web_runtime"
    ],
    "dynamic": [
      "private.capture_case_input(uuid,text)",
      "private.document_review_request_open(uuid,integer,text,text,text,text)",
      "private.document_review_request_current(uuid,uuid)",
      "public.case_documents_reserve(uuid,uuid,jsonb)",
      "public.case_documents_batch(uuid,uuid)",
      "public.case_documents_commit(uuid,uuid,jsonb)",
      "public.case_documents_snapshot(uuid)",
      "private.capture_case_input(uuid,text)",
      "private.document_review_request_current(uuid,uuid)",
      "private.document_review_request_open(uuid,integer,text,text,text,text)",
      "private.document_review_upload_bind(uuid,uuid)",
      "private.document_review_upload_snapshot(uuid,jsonb)"
    ]
  },
  {
    "file": "20260911171000_document_review_source_revisions.sql",
    "definers": [
      "private.document_review_source_refs",
      "private.document_review_source_admit",
      "private.document_review_source_read"
    ],
    "grants": [
      "private.document_review_source_admit(uuid,integer,text,uuid,date,text,jsonb,text) to tivdoc_worker_runtime",
      "private.document_review_source_read(uuid,integer,text,uuid,date,text) to tivdoc_worker_runtime"
    ],
    "dynamic": [
      "private.capture_case_input(uuid,text)"
    ]
  },
  {
    "file": "20260911171700_private_review_canonical_case_binding.sql",
    "definers": [
      "public.case_report_private_review_list",
      "public.case_report_private_review_artifact"
    ],
    "grants": [
      "public.case_report_private_review_list(uuid,uuid) to tivdoc_web_runtime",
      "public.case_report_private_review_artifact(uuid,uuid,uuid) to tivdoc_web_runtime"
    ],
    "dynamic": []
  },
  {
    "file": "20260911173000_legacy_scope_period_variable.sql",
    "definers": [],
    "grants": [],
    "dynamic": [
      "private.legacy_paid_scope_register(uuid,bytea,jsonb)"
    ]
  },
  {
    "file": "20260911173500_scoped_financial_source_completion.sql",
    "definers": [
      "private.document_review_information_satisfied_for_sweep"
    ],
    "grants": [
      "private.document_review_information_satisfied_for_sweep(uuid,uuid) to tivdoc_worker_runtime"
    ],
    "dynamic": [
      "private.document_review_upload_assess(uuid,integer,text,uuid,text,text)",
      "private.managed_dev_notification_event_current(uuid,text)",
      "public.case_request_sweep(timestamptz,integer)",
      "public.case_notification_request_reminders(integer)",
      "public.case_notification_reminder_enqueue(uuid,text,text,uuid,uuid,text,jsonb,timestamptz)",
      "public.case_notification_outbox_claim(uuid)"
    ]
  }
] as const;

const TARIFF_PERIOD_SURFACE = [
  {
    file: '20260912190000_travel_tariff_document_purpose.sql',
    literal: ['private.document_source_purpose_immutable','private.travel_tariff_paid','private.document_source_purpose_journal',
      'public.case_documents_reserve','private.document_tariff_upload_validate','private.document_tariff_upload_record','private.document_tariff_snapshot'],
    definers: ['public.case_documents_reserve','private.document_tariff_upload_validate','private.document_tariff_upload_record','private.document_tariff_snapshot'],
    grants: ['public.case_documents_reserve(uuid,uuid,jsonb,uuid) to service_role,tivdoc_web_runtime',
      'private.document_tariff_upload_validate(uuid,uuid,jsonb) to service_role,tivdoc_web_runtime',
      'private.document_tariff_upload_record(uuid,uuid,jsonb) to service_role,tivdoc_web_runtime',
      'private.document_tariff_snapshot(uuid,jsonb) to service_role,tivdoc_web_runtime'],
    dynamic: ['public.case_documents_reserve(uuid,uuid,jsonb)','public.case_documents_commit(uuid,uuid,jsonb)',
      'private.capture_case_input(uuid,text)','public.case_documents_snapshot(uuid)'],
    revokedNew: ['private.document_source_purpose_immutable()','private.travel_tariff_paid(uuid,date)','private.document_source_purpose_journal(uuid)',
      'public.case_documents_reserve(uuid,uuid,jsonb,uuid)','private.document_tariff_upload_validate(uuid,uuid,jsonb)',
      'private.document_tariff_upload_record(uuid,uuid,jsonb)','private.document_tariff_snapshot(uuid,jsonb)'],
  },
  {
    file: '20260912191500_travel_tariff_reading_targets.sql',
    literal: ['private.travel_tariff_target_matches','private.travel_tariff_target_current','private.travel_tariff_answer_valid',
      'private.document_field_current','private.document_reading_question_scope_v4'],
    definers: ['private.document_field_current'],
    grants: ['private.document_reading_question_scope_before_tariff_v1(text[],jsonb) to service_role,tivdoc_worker_runtime'],
    dynamic: ['private.document_field_current(uuid,jsonb)','private.document_reading_question_scope_v4(text[],jsonb)',
      'private.guard_document_cell_decision()','private.document_field_request_open(uuid,integer,text,jsonb,text)',
      'public.case_request_document_source(uuid,uuid,uuid)'],
    revokedNew: ['private.travel_tariff_target_matches(jsonb,jsonb)','private.travel_tariff_target_current(uuid,jsonb)',
      'private.travel_tariff_answer_valid(jsonb,text)','private.document_field_current_before_tariff_v1(uuid,jsonb)',
      'private.document_reading_question_scope_before_tariff_v1(text[],jsonb)'],
  },
  {
    file: '20260912193000_travel_tariff_review_upload.sql',
    literal: ['private.document_review_upload_validate'],
    definers: ['private.document_review_upload_validate'],
    grants: ['private.document_review_upload_validate(uuid,uuid,jsonb) to tivdoc_web_runtime,service_role'],
    dynamic: ['private.document_review_upload_validate(uuid,uuid,jsonb)','private.document_review_request_open(uuid,integer,text,text,text,text)',
      'private.document_review_upload_snapshot(uuid,jsonb)','public.case_documents_commit(uuid,uuid,jsonb)',
      'private.document_review_upload_received(uuid,uuid,jsonb)'],
    revokedNew: ['private.document_review_upload_validate_before_tariff_v1(uuid,uuid,jsonb)'],
  },
  {
    file: '20260912194500_document_source_period_association.sql',
    literal: ['private.source_period_subject_current','private.source_period_refs_in_scope','private.source_period_current_checkpoint',
      'private.source_period_target_in_scope','private.source_period_target_current','private.document_field_current',
      'private.document_reading_question_scope_v4','private.source_period_answer_valid'],
    definers: ['private.document_field_current'],
    grants: ['private.document_reading_question_scope_before_period_v1(text[],jsonb) to service_role,tivdoc_worker_runtime'],
    dynamic: ['private.document_field_current(uuid,jsonb)','private.document_reading_question_scope_v4(text[],jsonb)',
      'private.source_structure_target_current(jsonb,jsonb)','private.guard_document_cell_decision()',
      'private.document_field_request_open(uuid,integer,text,jsonb,text)','public.case_request_document_source(uuid,uuid,uuid)'],
    revokedNew: ['private.document_field_current_before_period_v1(uuid,jsonb)','private.document_reading_question_scope_before_period_v1(text[],jsonb)',
      'private.source_period_target_matches(jsonb,jsonb)','private.source_period_subject_current(jsonb,jsonb,jsonb)',
      'private.source_period_refs_in_scope(jsonb,text[],jsonb)','private.source_period_current_checkpoint(uuid,jsonb)',
      'private.source_period_target_in_scope(uuid,jsonb,text[])','private.source_period_target_current(uuid,jsonb)',
      'private.source_period_answer_valid(jsonb,text)'],
  },
  {
    file: '20260912194600_document_source_structure_period_witness.sql',
    literal: ['private.source_structure_period_readings','private.source_structure_period_witness','private.source_structure_period_target_in_scope',
      'private.source_structure_period_target_current','private.source_structure_period_answer_valid','private.document_field_current',
      'private.document_reading_question_scope_v4','public.case_request_source_period_context'],
    definers: ['private.document_field_current','public.case_request_source_period_context'],
    grants: ['private.document_reading_question_scope_before_structure_period_v2(text[],jsonb) to service_role,tivdoc_worker_runtime',
      'public.case_request_source_period_context(uuid,uuid,uuid) to service_role,tivdoc_web_runtime'],
    dynamic: ['private.document_field_current(uuid,jsonb)','private.document_reading_question_scope_v4(text[],jsonb)',
      'private.source_structure_subject_current(jsonb,jsonb,jsonb)','private.source_structure_target_current(jsonb,jsonb)',
      'private.source_period_current_checkpoint(uuid,jsonb)','private.guard_document_cell_decision()',
      'private.document_field_request_open(uuid,integer,text,jsonb,text)','public.case_request_document_source(uuid,uuid,uuid)'],
    revokedNew: ['private.document_field_current_before_structure_period_v2(uuid,jsonb)',
      'private.document_reading_question_scope_before_structure_period_v2(text[],jsonb)','private.source_structure_period_subject_matches(jsonb,jsonb,jsonb)',
      'private.source_structure_period_target_matches(jsonb,jsonb)','private.source_structure_period_checkpoint(uuid,jsonb)',
      'private.source_structure_period_readings(uuid,jsonb,jsonb)','private.source_structure_period_witness(uuid,jsonb,jsonb)',
      'private.source_structure_period_target_in_scope(uuid,jsonb,text[])','private.source_structure_period_target_current(uuid,jsonb)',
      'private.source_structure_period_answer_valid(jsonb,text)','public.case_request_source_period_context(uuid,uuid,uuid)'],
  },
] as const;

describe("security definer search_path contract", () => {
  it('inventories tariff and period definitions, explicit grants and preserved dynamic wrappers in 185–189',async()=>{
    const definitions=await securityDefinerDefinitions();
    for(const reviewed of TARIFF_PERIOD_SURFACE){
      const source=(await readFile(path.join(MIGRATION_ROOT,reviewed.file),'utf8')).replaceAll('\r\n','\n');
      const sql=source.replaceAll(/\s+/gu,' ').toLowerCase(),literal=[...source.matchAll(DEFINITION)];
      expect(literal.map(m=>m[1]),reviewed.file).toEqual(reviewed.literal);
      expect(definitions.filter(d=>d.file===reviewed.file).map(d=>d.name),reviewed.file).toEqual(reviewed.definers);
      expect(literal.filter(m=>!PINNED_EMPTY_SEARCH_PATH.test(m[3]??'')).map(m=>m[1]),reviewed.file).toEqual([]);
      expect([...sql.matchAll(/grant execute on function ([^;]+);/gu)].map(m=>m[1]),reviewed.file).toEqual(reviewed.grants);
      expect([...source.matchAll(/pg_get_functiondef\('([^']+)'::regprocedure\)/gu)].map(m=>m[1]),reviewed.file).toEqual(reviewed.dynamic);
      const revoked=[...sql.matchAll(/revoke all on function ([^;]+?) from ([^;]+);/gu)];
      for(const signature of reviewed.revokedNew){
        const entry=revoked.find(m=>m[1].replaceAll(/\s+/gu,'').split(/(?<=\)),/u).includes(signature));
        expect(entry?.[2],`${reviewed.file}: ${signature}`).toBe('public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime');
      }
      expect(sql,reviewed.file).not.toMatch(/drop\s+function|alter\s+function[\s\S]*?owner\s+to|grant\s+(?:all|select|insert|update|delete)\s/iu);
    }
  });
  it('inventories the exact AI/source boundaries without granting enrollment to a runtime',async()=>{
    const reviewed=[
      ['20260912080403_document_evidence_invocation_contract.sql',[],[]],
      ['20260912082645_document_evidence_identified_readings.sql',['private.document_field_current'],['private.document_reading_question_scope_before_evidence_v1(text[],jsonb) to tivdoc_worker_runtime,service_role']],
      ['20260912084511_document_evidence_answer_revision_currentness.sql',[],[]],
      ['20260912085031_ai_release_configuration_registry.sql',['private.ai_release_dependency','private.ai_release_dispatch_profile_guard','private.ai_release_refresh_dispatch','private.ai_release_context_read'],['private.ai_release_context_read(uuid,integer,text) to tivdoc_worker_runtime']],
      ['20260912090500_ai_release_findings.sql',['private.ai_release_findings_record'],['private.ai_release_findings_record(text,text,text) to tivdoc_worker_runtime']],
      ['20260912091000_document_evidence_retained_receipts.sql',['private.document_evidence_receipt_source'],['private.document_evidence_receipt_source(uuid) to tivdoc_worker_runtime']],
      ['20260912092000_ai_release_operator_events.sql',[],[]],
      ['20260912094426_ai_release_report_publication.sql',['private.ai_release_report_publish','public.case_notification_managed_dispatch','public.case_notification_managed_dispatch'],['private.ai_release_report_publish(uuid,text,uuid,text,text) to tivdoc_worker_runtime','public.case_notification_managed_dispatch(text,text,uuid,integer,text),public.case_notification_managed_dispatch(text,text,uuid,integer) to tivdoc_worker_runtime']],
      ['20260912102430_ai_release_managed_scope.sql',['private.managed_dev_worker_status','private.managed_dev_worker_status'],['private.managed_dev_worker_status(text,text),private.managed_dev_worker_status(text) to tivdoc_worker_runtime']],
      ['20260912104926_ai_release_machine_first_enrollment.sql',[],[]],
      ['20260912174500_owner_engineering_purpose.sql',['private.owner_engineering_run_record'],['private.owner_engineering_run_record(uuid,text,uuid,text,text) to tivdoc_worker_runtime']],
    ] as const;
    const definitions=await securityDefinerDefinitions();
    for(const [file,names,grants]of reviewed){
      expect(definitions.filter(d=>d.file===file).map(d=>d.name),file).toEqual(names);
      const sql=(await readFile(path.join(MIGRATION_ROOT,file),'utf8')).replaceAll(/\s+/gu,' ').toLowerCase();
      expect([...sql.matchAll(/grant execute on function ([^;]+);/gu)].map(m=>m[1]),file).toEqual(grants);
      expect(sql).not.toMatch(/alter\s+function[\s\S]*?owner\s+to/iu);
    }
    const operator=await readFile(path.join(MIGRATION_ROOT,reviewed[6][0]),'utf8');
    expect(operator).toContain("session_user<>'tivdoc_dev_migrator'");
    expect(operator).toContain("current_database()<>'tivdoc_release_replay_20260907'");
    expect(operator).toContain('security invoker');
    const profile=await readFile(path.join(MIGRATION_ROOT,reviewed[3][0]),'utf8');
    expect(profile).toContain("private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text");
    expect(profile).toContain('force row level security');
    expect(profile).toContain('AI_RELEASE_QA_ENROLLMENT_REQUIRED');
  });
  it('accounts for both prompt-derivation boundaries and their sole worker EXECUTE grant',async()=>{
    const file='20260911183000_extraction_prompt_derivation.sql';
    expect((await securityDefinerDefinitions()).filter(d=>d.file===file).map(d=>d.name)).toEqual([
      'private.extraction_prompt_derivation_get','private.extraction_prompt_derivation_put',
    ]);
    const sql=(await readFile(path.join(MIGRATION_ROOT,file),'utf8')).replaceAll(/\s+/gu,' ').toLowerCase();
    const signatures='private.extraction_prompt_derivation_get(uuid,integer,uuid,text),private.extraction_prompt_derivation_put(uuid,integer,uuid,text,jsonb)';
    expect([...sql.matchAll(/grant execute on function ([^;]+);/gu)].map(m=>m[1])).toEqual([signatures+' to tivdoc_worker_runtime']);
    expect(sql).toContain('revoke all on function '+signatures+' from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;');
    expect(sql).toContain("private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text");
    expect(sql).not.toMatch(/drop\s+function|alter\s+function[\s\S]*?owner\s+to/iu);
    const forward=await readFile(path.join(MIGRATION_ROOT,'20260911183500_extraction_prompt_qa_lock.sql'),'utf8');
    expect([...forward.matchAll(/pg_get_functiondef\('([^']+)'::regprocedure\)/gu)].map(m=>m[1]))
      .toEqual(['private.extraction_prompt_derivation_put(uuid,integer,uuid,text,jsonb)']);
    expect(forward).not.toMatch(/create\s+(?:or\s+replace\s+)?function|grant\s|revoke\s|alter\s+function/iu);
    expect(forward).toContain('EXTRACTION_PROMPT_QA_LOCK_DRIFT');
  });
  it('accounts for every product-upload declaration and exact EXECUTE role group in migrations 160–166',async()=>{
    const definitions=await securityDefinerDefinitions();
    expect(PRODUCT_UPLOAD_SURFACE.reduce((count,row)=>count+row.definers.length,0)).toBe(32);
    for(const reviewed of PRODUCT_UPLOAD_SURFACE){
      expect(definitions.filter(d=>d.file===reviewed.file).map(d=>d.name),reviewed.file).toEqual(reviewed.definers);
      const sql=(await readFile(path.join(MIGRATION_ROOT,reviewed.file),'utf8')).replaceAll(/\s+/gu,' ').toLowerCase();
      expect([...sql.matchAll(/grant execute on function ([^;]+);/gu)].map(m=>m[1]),reviewed.file).toEqual(reviewed.grants);
      for(const name of reviewed.definers){
        // Every literal definer explicitly removes PostgreSQL's default PUBLIC
        // execute; a later grant is allowed only by the exact role groups above.
        const escaped=name.replaceAll('.','\\.');
        expect(sql,`${reviewed.file}: ${name}`).toMatch(new RegExp(`revoke all on function ${escaped}\\([^;]+from public,anon,authenticated`,'u'));
      }
    }
  });
  it('inventories dynamic body-only replacements separately and refuses an unnoticed target or ACL rewrite',async()=>{
    for(const reviewed of PRODUCT_UPLOAD_SURFACE){
      const sql=await readFile(path.join(MIGRATION_ROOT,reviewed.file),'utf8');
      const targets=[...sql.matchAll(/pg_get_functiondef\('([^']+)'::regprocedure\)/gu)].map(m=>m[1]);
      expect(targets,reviewed.file).toEqual(reviewed.dynamic);
      expect(sql,reviewed.file).not.toMatch(/drop\s+function|alter\s+function[\s\S]*?owner\s+to/iu);
      if(reviewed.dynamic.length)expect(sql,reviewed.file).toMatch(/raise exception/iu);
    }
    const cell=await readFile(path.join(MIGRATION_ROOT,PRODUCT_UPLOAD_SURFACE[0].file),'utf8');
    expect(cell).toContain("foreach signature in array array['public.case_request_answer(uuid,uuid,text)','public.case_request_edit(uuid,uuid,uuid,text,integer,text)'] loop");
    expect(cell).toContain('definition:=pg_get_functiondef(signature::regprocedure)');
    expect(cell).toContain('READING_V2_WRITER_BASE_MISMATCH');
    const scoped=await readFile(path.join(MIGRATION_ROOT,PRODUCT_UPLOAD_SURFACE[6].file),'utf8');
    expect(scoped).toContain("pd->'review_completed_fact_keys'='[\"payslip.financial_source\"]'::jsonb");
    expect(scoped).toContain("session_user<>'tivdoc_worker_runtime'");
    expect(scoped).toContain('private.document_review_request_current(target_case,target_request)');
  });
  it('accounts for the five identified review boundaries and narrow grants',async()=>{
    const file='20260911144617_document_review_identified_completions.sql';
    expect((await securityDefinerDefinitions()).filter(d=>d.file===file).map(d=>d.name).sort()).toEqual([
      'private.document_review_answer_history','private.document_review_request_current','private.document_review_request_open',
      'private.guard_document_review_request','public.case_request_review_states',
    ]);
    const sql=(await readFile(path.join(MIGRATION_ROOT,file),'utf8')).replaceAll(/\s+/gu,' ').toLowerCase();
    expect(sql).toContain("session_user<>'tivdoc_worker_runtime'");
    expect(sql).toContain('grant execute on function private.document_review_request_open(uuid,integer,text,text,text,text) to tivdoc_worker_runtime');
    expect(sql).toContain('grant execute on function private.document_review_answer_history(uuid,integer,text) to tivdoc_worker_runtime');
    expect(sql).toContain('grant execute on function public.case_request_review_states(uuid,uuid) to tivdoc_web_runtime,service_role');
    expect(sql).toContain('revoke all on private.document_review_request_targets from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime');
  });
  it("accounts for all seven reviewed completion-round definitions and their role boundaries", async () => {
    const file = "20260911063456_managed_dev_completion_rounds.sql";
    const definitions = await securityDefinerDefinitions();
    expect(definitions.filter((definition) => definition.file === file)
      .map((definition) => definition.name).sort()).toEqual([
      "private.managed_completion_event_current",
      "private.managed_completion_has_new",
      "private.managed_completion_ready",
      "private.managed_completion_scope",
      "public.case_notification_completion_enqueue",
      "public.case_notification_completion_pending",
      "public.case_notification_managed_dispatch",
    ]);
    const sql = (await readFile(path.join(MIGRATION_ROOT, file), "utf8"))
      .replaceAll(/\s+/gu, " ").toLowerCase();
    const internal = "private.managed_completion_scope(text,uuid),private.managed_completion_ready(uuid),private.managed_completion_has_new(uuid,uuid[]),private.managed_completion_event_current(uuid,text)";
    const boundary = "public.case_notification_completion_pending(text),public.case_notification_completion_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text,text,uuid[]),public.case_notification_managed_dispatch(text,text,uuid,integer)";
    expect(sql).toContain(`revoke all on function ${internal} from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;`);
    expect(sql).toContain(`revoke all on function ${boundary} from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;`);
    expect([...sql.matchAll(/grant execute on function ([^;]+);/gu)].map((match) => match[1]))
      .toEqual([`${boundary} to tivdoc_worker_runtime`]);
  });
  it("accounts explicitly for ordinary signed-authority and publication boundaries",async()=>{
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>["20260910160042_june2026_regular_service_authority.sql","20260910160553_june2026_regular_hours_declarations.sql","20260910161527_june2026_regular_results_publication.sql"].includes(d.file)).map(d=>d.name).sort()).toEqual([
      "private.june2026_hours_admit","private.june2026_hours_answer_guard","private.june2026_hours_request_open","private.june2026_regular_authority","private.june2026_regular_result_save","public.case_request_regular_hours_states","public.june2026_regular_report_artifact",
    ]);
  });
  it("accounts for the three isolated canonical test boundaries",async()=>{
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>d.file==="20260910141530_june2026_isolated_canonical_assessments.sql").map(d=>d.name).sort()).toEqual(["private.june2026_canonical_test_customer","private.june2026_canonical_test_save","private.june2026_test_assessment"]);
  });
  it("accounts for the reviewed completion-binding redeclaration", async () => {
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>d.file==="20260910044646_dev_financial_completion_target_binding.sql").map(d=>d.name)).toEqual(["private.dev_financial_completions_bound"]);
  });
  it("accounts explicitly for the five source-completion definitions", async () => {
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>["20260910040429_document_source_transcriptions.sql","20260910040753_dev_financial_source_completion_runs.sql"].includes(d.file)).map(d=>d.name).sort()).toEqual([
      "private.dev_financial_completions_bound","private.document_transcription_current","private.document_transcription_request_open",
      "private.guard_document_transcription_answer","public.case_request_transcription_states",
    ]);
  });
  it("pins an empty search_path on every security definer function in the chain", async () => {
    const definitions = await securityDefinerDefinitions();
    const unpinned = definitions
      .filter((definition) => !PINNED_EMPTY_SEARCH_PATH.test(definition.header))
      .map((definition) => `${definition.file}: ${definition.name}`);
    expect(unpinned).toEqual([]);
  });

  it("counts the definer surface so a new one cannot arrive unnoticed", async () => {
    const definitions = await securityDefinerDefinitions();
    expect(definitions).toHaveLength(EXPECTED_SECURITY_DEFINER_DEFINITIONS);
  });

  it("retains the request opener boundary in the month-reading migration",async()=>{
    const file='20260912204417_source_intake_month_reading_and_request_scope.sql';
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>d.file===file).map(d=>d.name)).toEqual(['private.legacy_source_document_request_open']);
    const sql=await readFile(path.join(MIGRATION_ROOT,file),'utf8');
    expect([...sql.matchAll(/grant execute on function ([^;]+) to ([^;]+);/gu)].map(m=>[m[1],m[2]])).toEqual([
      ['private.legacy_source_document_request_open(uuid,integer,text,jsonb,text)','tivdoc_worker_runtime'],
    ]);
    expect(sql).toContain('cr.code=request_code');
    expect(sql).not.toContain('cr.code=code');
  });

  it('routes intake capture through the existing receipt boundary without a direct journal grant',async()=>{
    const file='20260912210515_source_intake_scoped_capture.sql';
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>d.file===file).map(d=>d.name)).toEqual(['private.document_review_upload_capture']);
    const sql=await readFile(path.join(MIGRATION_ROOT,file),'utf8');
    expect([...sql.matchAll(/pg_get_functiondef\('([^']+)'::regprocedure\)/gu)].map(m=>m[1])).toEqual(['public.case_documents_commit(uuid,uuid,jsonb)']);
    expect(sql).not.toMatch(/grant\s+(?:execute|all)|alter\s+function[\s\S]*?owner\s+to/iu);
    expect(sql).toContain('SOURCE_INTAKE_CAPTURE_BASE_REQUIRED');
    expect(sql).toContain('private.document_review_upload_capture(target_case,target_batch)');
  });

  it("inventories the source-intake definer declarations and worker boundaries",async()=>{
    const file="20260912194800_legacy_source_period_intake.sql";
    const definitions=await securityDefinerDefinitions();
    expect(definitions.filter(d=>d.file===file).map(d=>d.name).sort()).toEqual([
      "private.document_field_current","private.document_field_request_answer_valid","private.document_field_request_open",
      "private.document_physical_page_receipt_guard","private.document_physical_pages_record","private.guard_extraction_source_period_evidence",
      "private.legacy_scope_covers_month","private.legacy_source_document_request_open","private.legacy_source_intake_context",
      "private.legacy_source_upload_assessment_context","private.legacy_source_upload_assessment_record","private.legacy_source_upload_bind",
      "private.legacy_source_upload_commit_guard","private.legacy_source_upload_information_satisfied","private.legacy_source_upload_received",
      "private.legacy_source_upload_scope","private.legacy_source_upload_snapshot","private.legacy_source_upload_validate",
      "private.source_physical_pages_pending","private.upload_physical_pages_record",
      "public.case_request_source_intake_context","public.case_request_source_intake_upload_context",
    ].sort());
    const sql=await readFile(path.join(MIGRATION_ROOT,file),"utf8");
    expect([...sql.matchAll(/grant execute on function ([^;]+) to tivdoc_worker_runtime;/gu)].map(m=>m[1]).sort()).toEqual([
      "private.legacy_source_document_request_open(uuid,integer,text,jsonb,text)",
      "private.legacy_source_intake_context(uuid,bigint,text)",
      "private.source_physical_pages_pending(uuid,bigint,text)",
      "private.legacy_source_upload_assessment_context(uuid,bigint,text)",
      "private.legacy_source_upload_assessment_record(uuid,bigint,text,jsonb)",
    ].sort());
    expect(sql).not.toMatch(/grant\s+(?:all|select|insert|update|delete)\s+on\s+(?:table\s+)?private\./iu);
  });

  it("accounts for all four reviewed direct-receipt declarations", async () => {
    const definitions = await securityDefinerDefinitions();
    expect(definitions.filter((definition) => definition.file === "20260909212737_direct_resend_provider_receipts.sql")
      .map((definition) => definition.name).sort()).toEqual([
      "private.apply_direct_notification_events",
      "private.apply_notification_events",
      "public.case_notification_outbox_finish",
      "public.case_notification_record_provider",
    ]);
  });

  it("never schema-qualifies a parser construct", async () => {
    // `coalesce`, `nullif`, `greatest` and `least` are constructs, not
    // `pg_catalog` functions, so qualifying one raises 42883 the first time the
    // statement runs — which is exactly how the identity rotate and revoke
    // paths shipped broken in this same wave. Pinning search_path to '' invites
    // the mistake, because every other name in the body does need qualifying.
    const files = (await readdir(MIGRATION_ROOT)).filter((name) => name.endsWith(".sql")).sort();
    const offenders: string[] = [];
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATION_ROOT, file), "utf8");
      for (const match of sql.matchAll(/pg_catalog\.(coalesce|nullif|greatest|least)\s*\(/gu)) {
        offenders.push(`${file}: pg_catalog.${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
