-- v1.1 permits AI full reports on new AI offers. Historical v2 terms and the
-- existing automatic accuracy ceiling remain unchanged. This activates no rule.
alter table public.case_report_projections drop constraint report_document_v2_shape;
alter table public.case_report_projections add constraint report_document_versioned_shape
 check(report_document is null or coalesce((report_document->>'schema_version' in ('tivdoc-report-document-v2','tivdoc-report-document-v3')
 and report_document->>'case_id'=case_id::text and report_document->>'id'=id::text),false));

-- Extend the existing guard, retaining all current input/provenance checks.
do $upgrade$ declare definition text; anchor text; begin
 definition:=pg_get_functiondef('private.case_report_current_input()'::regprocedure);
 anchor:='  actual:=p.input_revision;';
 if strpos(definition,anchor)=0 then raise exception 'AI_PUBLICATION_GUARD_ANCHOR_MISSING';end if;
 definition:=replace(definition,anchor,$guard$
  if p.report_document->>'schema_version'='tivdoc-report-document-v3' then
   if new.state<>'published' or TG_OP<>'INSERT' or session_user<>'tivdoc_worker_runtime'
    or private.runtime_verified_tenant() is distinct from 'saved-case:'||new.case_id::text
    or new.operator_identity is distinct from 'system:ai_publication_v1'
    or p.report_document->>'service_kind' is distinct from 'ai_assisted'
    or p.report_document->>'publication_policy' is distinct from 'tivdoc-ai-publication-v1'
    or p.report_document#>>'{publication,state}' is distinct from 'draft'
    or p.report_document#>>'{publication,approval_actor_kind}' is distinct from 'automation'
   then raise exception 'REPORT_AI_AUTHORITY_REQUIRED';end if;
   if not exists(select 1 from private.product_orders o where o.id::text=p.report_document->>'order_id' and o.case_id=new.case_id
    and o.kind='full' and o.offer->>'version'='tivdoc-order-offer-v2' and o.offer->>'service_kind'='ai_assisted'
    and o.offer->'human_review_required'='false'::jsonb and o.offer_sha256=p.report_document->>'order_offer_sha256')
   then raise exception 'REPORT_AI_ORDER_REQUIRED';end if;
   if not exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'gate'='checked')
    or exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'gate'='checked' and (
      t->>'activation' is distinct from 'active' or t->>'applicability' is distinct from 'applicable'
      or t->'basis_complete' is distinct from 'true'::jsonb or t->>'certainty' not in ('high','medium')
      or jsonb_typeof(t->'parameter_grades') is distinct from 'object' or t->'parameter_grades'='{}'::jsonb
      or exists(select 1 from jsonb_each_text(t->'parameter_grades') grade where grade.value<>'active')))
    or p.projection::text like '%conflict:%'
   then raise exception 'REPORT_AI_RESULT_NOT_PERMITTED';end if;
   if exists(select 1 from jsonb_array_elements(p.report_document->'evidence') e where
    not exists(select 1 from public.documents d where d.case_id=new.case_id and d.id::text=e->>'document_id'
      and d.version_id::text=e->>'version_id' and d.content_sha256=e->>'sha256')
    and not exists(select 1 from public.document_versions v where v.case_id=new.case_id and v.document_id::text=e->>'document_id'
      and v.version_id::text=e->>'version_id' and exists(select 1 from public.document_upload_batches b
       cross join lateral jsonb_array_elements(b.files) f where b.case_id=v.case_id and b.completed_at is not null
       and f->>'versionId'=v.version_id::text and f->>'path'=v.storage_path and f->>'sha256'=e->>'sha256')))
   then raise exception 'REPORT_AI_SOURCE_HASH_MISMATCH';end if;
  end if;
  actual:=p.input_revision;$guard$);
 anchor:='new.report_kind<>''initial'' or new.document_track<>''automatic''';
 if strpos(definition,anchor)=0 then raise exception 'AI_PUBLICATION_KIND_ANCHOR_MISSING';end if;
 definition:=replace(definition,anchor,'(new.report_kind<>''initial'' and p.report_document->>''schema_version''<>''tivdoc-report-document-v3'') or new.document_track<>''automatic''');
 anchor:='new.operator_identity<>''system:publication_gate''';
 if strpos(definition,anchor)=0 then raise exception 'AI_PUBLICATION_ACTOR_ANCHOR_MISSING';end if;
 definition:=replace(definition,anchor,'new.operator_identity is distinct from (case when p.report_document->>''schema_version''=''tivdoc-report-document-v3'' then ''system:ai_publication_v1'' else ''system:publication_gate'' end)');
 execute definition;
 definition:=pg_get_functiondef('public.case_report_customer_snapshot(uuid,uuid)'::regprocedure);
 anchor:='q.operator_identity=''system:publication_gate''';
 if strpos(definition,anchor)=0 then raise exception 'AI_PUBLICATION_READER_ANCHOR_MISSING';end if;
 execute replace(definition,anchor,'q.operator_identity in (''system:publication_gate'',''system:ai_publication_v1'')');
end $upgrade$;

-- An invoker composes existing RLS and the authenticated, case-locking context.
-- The expected saved document prevents a read/decision race. No caller timestamp,
-- actor, amount or customer-facing prose can be submitted here.
create function private.report_ai_publish(target_case uuid,target_identity uuid,target_projection uuid,expected_document jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.case_report_projections; q public.case_report_qa;
begin
 perform private.order_quote_context(target_case,target_identity);
 select * into p from public.case_report_projections where id=target_projection and case_id=target_case;
 if p.id is null or p.report_document is distinct from expected_document
  or p.report_document->>'schema_version' is distinct from 'tivdoc-report-document-v3' then raise exception 'REPORT_AI_DOCUMENT_CHANGED';end if;
 select * into q from public.case_report_qa where projection_id=p.id and case_id=target_case and published_at is not null order by published_at limit 1;
 if q.id is not null then
  if q.operator_identity<>'system:ai_publication_v1' then raise exception 'REPORT_AI_DECISION_CONFLICT';end if;
  return jsonb_build_object('projection_id',p.id,'qa_id',q.id,'published_at',q.published_at,'replayed',true);
 end if;
 if exists(select 1 from public.case_report_qa where projection_id=p.id and case_id=target_case) then raise exception 'REPORT_AI_DECISION_CONFLICT';end if;
 select * into q from public.case_report_qa_enqueue(target_case,p.id,p.report_kind,'automatic',array[]::text[],'published','system:ai_publication_v1');
 if q.id is null then raise exception 'REPORT_AI_DECISION_MISSING';end if;
 return jsonb_build_object('projection_id',p.id,'qa_id',q.id,'published_at',q.published_at,'replayed',false);
end;$$;
revoke all on function private.report_ai_publish(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.report_ai_publish(uuid,uuid,uuid,jsonb) to tivdoc_worker_runtime;
