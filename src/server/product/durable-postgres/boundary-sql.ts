import { statement, type PostgresParameter, type PostgresStatement } from "../../platform/persistence/postgres/contracts.ts";

const SQL = Object.freeze({
  identityRead: "select * from private.product_identity_session_read($1)",
  identityRegister: "select * from private.product_identity_session_register($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$7,$8::timestamptz)",
  identityRotate: "select private.product_session_rotate($1,$2,$3,$4::timestamptz) as accepted",
  identityRevoke: "select private.product_session_revoke($1,$2::timestamptz) as accepted",
  ownerBind: "select * from private.product_case_owner_bind($1,$2,$3,$4,$5::timestamptz)",
  ownerLookup: "select * from private.product_owner_lookup($1,$2,$3)",
  ownerRevoke: "select private.product_owner_revoke($1,$2,$3,$4::timestamptz) as accepted",
  privacyAppend: "select * from private.product_privacy_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)",
  reportBind: "select * from private.product_private_report_object_bind($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz)",
  reportApprove: "select private.product_report_object_approve($1,$2,$3,$4) as accepted",
  reportApprovedRead: "select * from private.product_report_object_approved_read($1,$2,$3,$4,$5,$6)",
  reportRevoke: "select private.product_report_object_revoke($1,$2,$3,$4,$5,$6::timestamptz) as accepted",
} as const);

export const DURABLE_BOUNDARY_SQL_TEXT = SQL;

export const DURABLE_REPORT_IDENTITY_SQL_TEXT = `select
  report.tenant_id,
  report.canonical_case_id,
  state.revision::text as case_revision,
  run.canonical_analysis_run_id,
  run.case_revision::text as analysis_run_revision,
  run.completion_payload -> 'bundle' -> 'rule_inputs' as rule_inputs,
  run.completion_payload -> 'dependencies' as dependencies,
  report.report_id,
  report.revision::text as report_revision,
  report.analysis_result_sha256,
  report.json_sha256,
  report.html_sha256,
  report.manifest_sha256,
  report.report_sha256,
  report.pdf_sha256,
  owner.revision::text as owner_binding_revision,
  owner.binding_sha256 as owner_binding_sha256,
  approval.task_id as approval_task_id,
  approval.revision::text as approval_revision,
  approval.decision_sha256 as approval_decision_sha256
from public.engine_report_versions report
join public.engine_case_state state
  on state.case_id = report.case_id and state.tenant_id = report.tenant_id
join public.analysis_runs run
  on run.id = report.analysis_run_id and run.tenant_id = report.tenant_id
join public.product_case_owners owner
  on owner.tenant_id = report.tenant_id
 and owner.canonical_case_id = report.canonical_case_id
 and owner.status = 'active' and owner.revoked_at is null
join lateral (
  select review.task_id, review.revision, review.decision_sha256
  from public.engine_review_task_versions review
  where review.tenant_id = report.tenant_id
    and review.case_id = report.case_id
    and review.report_id = report.report_id
    and review.report_revision = report.revision
    and review.report_sha256 = report.report_sha256
    and review.task_kind = 'report_approval'
    and review.release_state = 'approved'
    and review.invalidated_at is null
    and review.decision_payload ->> 'decision' = 'approved'
    and not exists (
      select 1 from public.engine_review_task_versions newer
      where newer.tenant_id = review.tenant_id
        and newer.task_id = review.task_id
        and newer.revision > review.revision
    )
  order by review.revision desc
  limit 1
) approval on true
where report.tenant_id = $1
  and report.canonical_case_id = $2
  and report.report_id = $3
  and report.revision = $4
  and report.revision = state.revision
  and state.lifecycle_state not in ('release_hold', 'cancelled')
  and run.canonical_case_id = report.canonical_case_id
  and run.canonical_analysis_run_id = report.canonical_analysis_run_id
  and run.status = 'completed'
  and report.review_eligible = true
  and report.tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
limit 1` as const;

function named(name: string, text: string, values: readonly PostgresParameter[]): PostgresStatement {
  return statement(name, text, values);
}

export const durableBoundaryStatements = Object.freeze({
  identityRead: (sid: string) => named("product_identity_read", SQL.identityRead, [sid]),
  identityRegister: (values: readonly PostgresParameter[]) => named("product_identity_register", SQL.identityRegister, values),
  identityRotate: (values: readonly PostgresParameter[]) => named("product_identity_rotate", SQL.identityRotate, values),
  identityRevoke: (values: readonly PostgresParameter[]) => named("product_identity_revoke", SQL.identityRevoke, values),
  ownerBind: (values: readonly PostgresParameter[]) => named("product_owner_bind", SQL.ownerBind, values),
  ownerLookup: (values: readonly PostgresParameter[]) => named("product_owner_lookup", SQL.ownerLookup, values),
  ownerRevoke: (values: readonly PostgresParameter[]) => named("product_owner_revoke", SQL.ownerRevoke, values),
  privacyAppend: (values: readonly PostgresParameter[]) => named("product_privacy_append", SQL.privacyAppend, values),
  reportBind: (values: readonly PostgresParameter[]) => named("product_report_bind", SQL.reportBind, values),
  reportApprove: (values: readonly PostgresParameter[]) => named("product_report_approve", SQL.reportApprove, values),
  reportApprovedRead: (values: readonly PostgresParameter[]) => named("product_report_read", SQL.reportApprovedRead, values),
  reportRevoke: (values: readonly PostgresParameter[]) => named("product_report_revoke", SQL.reportRevoke, values),
  reportIdentity: (values: readonly PostgresParameter[]) => named(
    "product_report_identity_context",
    DURABLE_REPORT_IDENTITY_SQL_TEXT,
    values,
  ),
});
