-- Forward extension of the existing immutable dispatch receipt. The routing
-- month is not an assertion that a contract or attendance sheet covers it.
-- Historical payslip checks, tenant RLS and immutable-response trigger remain.
alter table private.case_extraction_invocations
 drop constraint case_extraction_invocations_check1;
alter table private.case_extraction_invocations
 add constraint case_extraction_invocations_check1 check (
  result is null or coalesce(
   result->>'case_id'=case_id::text
   and result->>'version_id'=version_id::text
   and result->>'input_sha256'=input_sha256
   and result->>'result_sha256'=result_sha256
   and case when result->>'schema_version'='tivdoc-saved-document-evidence-v1' then
    policy_version='saved-document-evidence-v1'
    and result->>'policy_version'=policy_version
    and result->>'dispatch_month'=expected_month
    and jsonb_typeof(result->'requested_months')='array'
    and result->'requested_months' ? expected_month
    and result#>>'{run,result,provider_receipt,case_id}'=case_id::text
    and result#>>'{run,result,provider_receipt,document_id}'=version_id::text
    and result#>>'{run,result,provider_receipt,source_sha256}'=input_sha256
   else result->>'expected_month'=expected_month end,
  false)
 );
