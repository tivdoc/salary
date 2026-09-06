-- Site S2.4 (long run 11). "אמצא אחר כך" — I'll find it later.
--
-- Choosing that in the funnel is NOT a dead end and NOT a refusal to serve. The
-- case opens, the questionnaire is kept, and a blocking request goes on the
-- thread asking for the payslip. What changes is only that the case is honest
-- about what it is waiting for.
--
-- `awaiting_document` is a state of its own rather than a flag on `started`
-- because three different things read it: the case screen (which says what the
-- next action is), the SLA clock (D-7.2 — it does not run while a blocking
-- request is open, and this case has one by construction), and the operator
-- queue (a case waiting on the customer is not a case waiting on us). A boolean
-- would have left all three inferring it from something else.
--
-- Where it can go from here: `documents_uploaded`, once the payslip arrives
-- through the same review screen the funnel uses. Nothing else moves it, and
-- the request on the thread is what carries the ten-day expiry (D-9).

alter table public.cases
  drop constraint cases_status_check;

alter table public.cases
  add constraint cases_status_check check (
    status in (
      'started',
      'questionnaire_completed',
      'awaiting_document',
      'documents_uploaded',
      'payment_pending',
      'paid',
      'under_review',
      'completed'
    )
  );

comment on column public.cases.status is
  'S2.4 added awaiting_document: the customer said they would find the payslip later. The case is open, a blocking request on the thread asks for it, and the SLA clock does not run while that request is unanswered (D-7.2).';
