-- Site S2.4 (long run 11). The link that brings a customer back with the payslip.
--
-- "אמצא אחר כך" opens a blocking request on the thread (D-2) and puts the case
-- in `awaiting_document`. The customer then closes the browser. What brings them
-- back is the same one-time link U4 already builds — issued here under a fourth
-- purpose so the row says what it was for, and so the partial unique index that
-- guards `payment_verified` (one live link per case) keeps ignoring it: a
-- document request can be re-sent with the reminders D-9 schedules, and a
-- payment link still cannot.
--
-- Nothing else about the token changes: same TTL, same one-time exchange, same
-- six-digit code on arrival. Only the reason it exists is new.

alter table public.case_access_tokens
  drop constraint case_access_tokens_purpose_check;

alter table public.case_access_tokens
  add constraint case_access_tokens_purpose_check check (
    purpose in ('payment_verified', 'resend', 'report_ready', 'document_request')
  );

comment on column public.case_access_tokens.purpose is
  'Why the link exists: payment_verified (the case link, one live per case), resend (U5), report_ready (the report is ready), document_request (S2.4 — the case is waiting for a payslip the customer said they would find later).';
