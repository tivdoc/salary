-- Site S2 / S2.2 (long run 10). More than one payslip per case, and a named
-- month the initial check runs on.
--
-- What forbade it: `unique (case_id, document_type)`. One payslip per case,
-- full stop — so a customer with three months to check either uploaded one and
-- lost the rest, or the upload path used `upsert: true` and the second payslip
-- silently replaced the first. Both are the refund this wave exists to prevent.
--
-- What replaces it: a SLOT. `payslip-01` … `payslip-12`, plus `contract` and
-- `attendance`, unique per case. The document type stays (it is what the engine
-- reads); the slot is what makes two payslips two documents. Nothing upserts
-- over a slot that is already filled — replacing a file is a delete and an
-- insert, which is a decision the customer makes on the review screen, not a
-- side effect of uploading again.
--
-- `period_month` is the month a payslip covers, and `cases.check_period_month`
-- is the one month the INITIAL check runs on (D-4.1: the initial check is a
-- single month). The default is the last complete month, and the customer can
-- change it before paying; the full report covers every month uploaded.

alter table public.documents
  add column if not exists slot text,
  add column if not exists period_month date;

-- Existing rows: the single payslip becomes slot payslip-01, the others keep their own name.
update public.documents
set slot = case when document_type = 'payslip' then 'payslip-01' else document_type end
where slot is null;

alter table public.documents
  alter column slot set not null,
  add constraint documents_slot_check
    check (slot ~ '^(payslip-(0[1-9]|1[0-2])|contract|attendance)$'),
  -- A slot must belong to its own kind: payslip-07 can only ever hold a payslip.
  add constraint documents_slot_matches_type_check
    check (
      (document_type = 'payslip' and slot like 'payslip-%')
      or (document_type <> 'payslip' and slot = document_type)
    );

alter table public.documents
  drop constraint if exists documents_case_id_document_type_key;

alter table public.documents
  add constraint documents_case_id_slot_key unique (case_id, slot);

-- The month the initial check runs on. Null until the customer confirms it.
alter table public.cases
  add column if not exists check_period_month date;

comment on column public.documents.slot is
  'S2.2: payslip-01..payslip-12, contract, attendance. Unique per case — this is what lets a case hold more than one payslip, and what stops a second upload from overwriting the first.';
comment on column public.documents.period_month is
  'The month this payslip covers, as its first day. Null for a contract or an attendance report.';
comment on column public.cases.check_period_month is
  'S2.2 / D-4.1: the single month the INITIAL check runs on. Defaults to the last complete month and is confirmed by the customer before payment; the full report covers every month uploaded.';
