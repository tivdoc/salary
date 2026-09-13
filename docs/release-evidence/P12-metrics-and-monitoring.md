# P12 — metric semantics and recovery

AI implementation decision; not a human operations sign-off. Dictionary `published-topic-semantics-v1` reads gates/statuses from saved published projections. It does not equate historical S04/S05 labels with current outcomes. `not_checked` requires zero checked topics, `finding` requires a checked finding, and `no_finding_in_checked_scope` is limited to checked coverage. A missing metric response is an error. Unknown processing cost/Storage integrity stay unmeasured. Missing human review duration is not zero minutes.

The window is 30 days. Case conversions use non-QA cases created in that window, observed up to its end. Anonymous visits/starts use sessions observed in the window, excluding sessions linked to known QA. These two populations are explicitly labeled; ratios across their boundary are descriptive, not causal cohort conversion or extraction accuracy. Payments require verified_at, reports require actual publication, and full purchases must follow the case's first published finding. Report opens require owner authorization and visible client rendering; retries deduplicate by identity/report. This is opening evidence, not proof the customer read/understood the result. Ratios expose numerator, denominator, period and sample; no sample means unavailable. No target mix changes conclusions.

Monitor covers all operational rows including QA; it is deliberately separate from business metrics. SQL reads actual dispatch age, expired job leases, dead letters, notification backlog, uncertain checkouts, unlinked published delivery and overdue privacy intake. Service clocks use persisted budget/calendar/pauses; overlaps are subtracted once, unknown calendars remain unknown, and the oldest-100 bound is disclosed. `/api/health` is process liveness and configuration presence only, expressly not service readiness.

Recovery instructions:

- `dispatch_pending`: check processing admission; resume existing source dispatcher with the same case/revision. Full canonical worker composition remains P05.
- `job_lease_expired`: let the existing fenced worker reclaim; do not edit lease/token values manually. `job_dead_letter`: inspect immutable job history and refusal before canonical replay.
- `notification_stalled`: inspect worker flag/provider configuration, then run `scripts/product-workers/notification-delivery.mts` under its existing explicit flags. Same delivery ID and provider idempotency key are retained.
- `notification_dead_letter`: distinguish expired code/link from provider suppression. Never replay an expired credential or bypass suppression. A newly requested verified code is a new explicit access action.
- `payment_uncertain`: use the existing reconciliation endpoint/worker against the stored clearing-log/order coordinates. Never reset a checkout claim or charge again to resolve uncertainty.
- `published_delivery_unlinked`: drain the existing publication intention with report-notification delivery enabled; do not republish. Publication and delivery remain separate states.
- `privacy_overdue`: review the private operations queue; record handling/restriction, never mark erasure completed from intake.

Configuration flags are displayed as configured enablement, not proof a worker/provider is running. Sales, checkout, processing, message/reminder delivery and Storage deletion remain separate. Complete publication/topic control composition, observed provider costs, full Storage-reference scan, live scheduler/runbook recovery and browser evidence remain open. No production flag was enabled.
