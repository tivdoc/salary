-- Additive operational mode. Existing receipt-only epochs and their immutable
-- bytes remain historical. This grants no worker, provider spending or
-- calculation authority: the operator must prepare each independently.
alter table private.managed_dev_lifecycle_epochs
 add column provider_authorization_sha256 text;

do $migration$
declare old_constraint text;
begin
 select conname into strict old_constraint from pg_constraint
 where conrelid='private.managed_dev_lifecycle_epochs'::regclass
 and contype='c' and pg_get_constraintdef(oid) =
  'CHECK ((provider_policy = ''saved_receipts_only''::text))';
 execute format('alter table private.managed_dev_lifecycle_epochs drop constraint %I',old_constraint);
end;
$migration$;

alter table private.managed_dev_lifecycle_epochs
 add constraint managed_dev_epoch_provider_policy_v2 check (
  (provider_policy='saved_receipts_only' and provider_authorization_sha256 is null)
  or (provider_policy='sol_managed_live_window_v2'
   and provider_authorization_sha256 is not null
   and provider_authorization_sha256 ~ '^[a-f0-9]{64}$')
 );

comment on column private.managed_dev_lifecycle_epochs.provider_authorization_sha256 is
 'Exact immutable private live-window file hash. The v2 operator and worker separately verify QA owner/case/source/version/build, <=4h expiry, capability binding and cumulative budget. Never a calculation or publication approval.';

-- No grants are added. The existing immutable trigger, RLS, owner-only writes,
-- bounded machine window, revocation and session checks remain in effect.
