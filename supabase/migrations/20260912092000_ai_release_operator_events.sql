-- Owner-operated, append-only DEV enrollment. This grants neither machine
-- access nor provider spending and cannot renew a policy/source receipt.
create function private.ai_release_enrollment_record(target_case uuid,configuration_sha text,request_key text,event_kind text,
 issued_at timestamptz,expires_at timestamptz,event_reason text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare previous private.ai_release_enrollment_events;existing private.ai_release_enrollment_events;written private.ai_release_enrollment_events;begin
 if session_user<>'tivdoc_dev_migrator' or current_database()<>'tivdoc_release_replay_20260907' then raise exception 'AI_RELEASE_OPERATOR_DEV_ONLY';end if;
 perform 1 from public.cases c where c.id=target_case and c.is_qa for update;
 if not found then raise exception 'AI_RELEASE_QA_ENROLLMENT_REQUIRED';end if;
 if configuration_sha is null or configuration_sha!~'^[a-f0-9]{64}$' or request_key is null or char_length(request_key) not between 8 and 200
  or event_kind is null or event_kind not in ('granted','revoked') or event_reason is null or char_length(event_reason) not between 10 and 1000
  or issued_at is null or expires_at is null or expires_at<=issued_at or expires_at>issued_at+interval '24 hours' then raise exception 'AI_RELEASE_OPERATOR_INPUT';end if;
 select * into existing from private.ai_release_enrollment_events e where e.case_id=target_case and e.idempotency_key=request_key;
 if found then
  if existing.configuration_sha256<>configuration_sha or existing.kind<>event_kind or existing.issued_at<>issued_at or existing.expires_at<>expires_at or existing.reason<>event_reason then raise exception 'AI_RELEASE_ENROLLMENT_RETRY_MISMATCH';end if;
  written:=existing;
 else
  select * into previous from private.ai_release_enrollment_events e where e.case_id=target_case order by e.sequence desc limit 1;
  insert into private.ai_release_enrollment_events(event_id,case_id,sequence,predecessor_id,configuration_sha256,kind,idempotency_key,issued_at,expires_at,reason)
   values(gen_random_uuid(),target_case,coalesce(previous.sequence,0)+1,previous.event_id,configuration_sha,event_kind,request_key,issued_at,expires_at,event_reason)
   returning * into written;
 end if;
 return jsonb_build_object('schema_version','ai-release-enrollment-receipt-v1','event_id',written.event_id,'case_id',written.case_id,
  'sequence',written.sequence,'predecessor_id',written.predecessor_id,'configuration_sha256',written.configuration_sha256,'kind',written.kind,
  'request_key',written.idempotency_key,'issued_at',written.issued_at,'expires_at',written.expires_at,'reason',written.reason,
  'replayed',existing.event_id is not null,'current',written.event_id=(select e.event_id from private.ai_release_enrollment_events e where e.case_id=target_case order by e.sequence desc limit 1),
  'authority_dependency_sha256',private.ai_release_dependency(target_case));
end;$$;
revoke all on function private.ai_release_enrollment_record(uuid,text,text,text,timestamptz,timestamptz,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- The migration owner retains execution; runtime roles have no table or RPC
-- access for issuing configuration/enrollment. Operator receipt input is fixed
-- across retries, so a retry cannot extend a window or revive a revoked grant.
