-- Site S4 (2.6, long run 12). The consent a person gives before they pay.
--
-- Two columns rather than one boolean, because a boolean answers the wrong
-- question. "Did they agree?" is not useful a year later; "what did they agree
-- to, and when?" is. `terms_version` holds the same string the terms page
-- prints (src/lib/legal-terms.ts), so a later change to the terms cannot
-- retroactively reinterpret an agreement someone gave to the earlier text.
--
-- The pairing constraint is the point: the two move together or not at all.
-- A row with a timestamp and no version would be a consent to nothing in
-- particular, which is worse than no record — it looks like evidence.
--
-- Not null-able away: nothing here backfills a consent for the cases that came
-- before this migration. They did not give one, and pretending otherwise is
-- exactly the failure this column exists to prevent.

alter table public.cases
  add column if not exists terms_accepted_at timestamptz null,
  add column if not exists terms_version text null;

alter table public.cases
  drop constraint if exists cases_terms_consent_pairing_check;

alter table public.cases
  add constraint cases_terms_consent_pairing_check check (
    (terms_accepted_at is null and terms_version is null)
    or (terms_accepted_at is not null and terms_version is not null and char_length(terms_version) between 4 and 40)
  );

comment on column public.cases.terms_accepted_at is
  'S4 2.6: when the customer ticked the consent box on the payment screen. Null means they have not; nothing backfills it.';
comment on column public.cases.terms_version is
  'S4 2.6: which terms they agreed to — the same string the terms page prints, so a later revision cannot reinterpret an earlier consent.';
