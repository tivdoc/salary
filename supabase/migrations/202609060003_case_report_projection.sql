-- Site S3.2 (long run 11). `case_report_projection` v1 — the one contract
-- between the legal engine and the product.
--
-- What this table is: the finished answer, already decided. The product reads
-- a row and renders it. No screen computes a figure, downgrades a certainty or
-- decides a topic was checked; every one of those decisions is made where the
-- evidence lives and arrives here already made.
--
-- Who may write it, and when: NOBODY yet. The engine is granted insert in run
-- 16, once its outputs are real; until then the only documents are the fixtures
-- in `case-report-projection.fixtures.ts`, and the only rows are the ones a
-- proof inserts as the migrator and rolls back. Granting insert now would let
-- an unattested computation reach a customer screen, which is precisely what
-- the three gates exist to prevent.
--
-- Append-only, deliberately. A recomputation is a NEW row, never an edit: a
-- customer who saw a figure yesterday must be able to see what they saw, and an
-- operator investigating a complaint needs the document as it was rendered, not
-- as it would be rendered now. `superseded_at` marks the older one; nothing is
-- deleted.

create table if not exists public.case_report_projections (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  schema_version text not null check (schema_version = 'tivdoc-case-report-projection-v1'),
  report_kind text not null check (report_kind in ('initial', 'full')),
  -- The month the initial check ran on (D-4.1). The full report covers more.
  check_period_month date not null,
  -- The validated document. Its shape is enforced in code by
  -- caseReportProjectionSchema before anything is written or rendered; the
  -- database holds the three gates it can hold cheaply and leaves the rest there.
  projection jsonb not null,
  projection_sha256 text not null check (projection_sha256 ~ '^[a-f0-9]{64}$'),
  -- Errata #1 is owner-closed; every document says which basis it ran on.
  legal_basis text not null check (legal_basis = 'opinion_3ddad7e8 + errata_1_owner_closed'),
  generated_at timestamptz not null,
  created_at timestamptz not null default now(),
  superseded_at timestamptz null,
  -- Cheap structural guards for what the database can see on its own.
  constraint case_report_projections_topics_check
    check (jsonb_typeof(projection -> 'topics') = 'array' and jsonb_array_length(projection -> 'topics') = 7),
  constraint case_report_projections_basis_matches_check
    check (projection ->> 'legal_basis' = legal_basis),
  constraint case_report_projections_version_matches_check
    check (projection ->> 'schema_version' = schema_version)
);

create index if not exists case_report_projections_case_idx
  on public.case_report_projections (case_id, generated_at desc);

alter table public.case_report_projections enable row level security;
alter table public.case_report_projections force row level security;

-- The runtime roles may READ. None may write: the engine's insert grant is run
-- 16's, and an operator publishing a report writes an event, never this row.
revoke all on table public.case_report_projections from anon, authenticated, service_role;
grant select on table public.case_report_projections to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime;

create policy case_report_projections_runtime_read on public.case_report_projections
  for select to tivdoc_web_runtime, tivdoc_operations_runtime, tivdoc_worker_runtime
  using (true);

comment on table public.case_report_projections is
  'S3.2 v1: the finished report the product renders and never computes. Append-only — a recomputation is a new row so a customer can always see what they were shown. No role holds insert: the engine is granted it in run 16, and until then the only documents are fixtures.';
comment on column public.case_report_projections.projection is
  'The validated document. Every topic carries the three gates in order: activation (active | awaiting_verification), applicability (applicable | refused:<fact>), and certainty only when both pass. A topic that is not active carries no direction, no range and no amount at all.';
