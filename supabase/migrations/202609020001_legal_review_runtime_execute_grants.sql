-- V0.10.13 forward-only least-privilege legal review runtime grant repair.
--
-- Migration 011 created the three legal review entry points as SECURITY DEFINER
-- functions owned by tivdoc_governance_owner, revoked them from public, anon,
-- authenticated and service_role, and granted execute to the owning role only.
-- It never granted them to the runtime principals that actually call them, so
-- every operations request reached the database and was refused by the ACL
-- check with SQLSTATE 42501. Every other governance family in migration 005
-- carries these grants; this one was omitted.
--
-- This is the missing half of the least-privilege model, not a widening: the
-- functions stay SECURITY DEFINER and owned by the governance owner, the
-- revocations from public and the Supabase reserved roles stand untouched, and
-- each principal receives only the exact signatures it invokes.
--
--   queue_list    read the review queue                -> operations
--   action_append record a reviewer action             -> operations
--   packet_enqueue project an observation into the queue -> worker, operations
--
-- Granting a principal execute on a SECURITY DEFINER function is the mechanism
-- by which the runtime reaches governance state at all; the alternative is a
-- runtime role holding direct table privileges, which is what these functions
-- exist to prevent.

revoke all on function private.governance_legal_review_queue_list(
  text,integer
) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_review_action_append(
  text,jsonb,text,text,text,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_review_packet_enqueue(
  text,jsonb,integer,jsonb,text,text,timestamptz
) from public, anon, authenticated, service_role;

grant execute on function private.governance_legal_review_queue_list(
  text,integer
) to tivdoc_operations_runtime;
grant execute on function private.governance_legal_review_action_append(
  text,jsonb,text,text,text,text,timestamptz
) to tivdoc_operations_runtime;
grant execute on function private.governance_legal_review_packet_enqueue(
  text,jsonb,integer,jsonb,text,text,timestamptz
) to tivdoc_operations_runtime, tivdoc_worker_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_review_runtime_execute_grants',
  'tivdoc-legal-review-runtime-execute-grants-v0.10.13',
  '202609020001_legal_review_runtime_execute_grants'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.governance_legal_review_queue_list(text,integer) is
  'Durable legal review queue projection; executable only by the explicitly granted least-privilege operations principal.';
