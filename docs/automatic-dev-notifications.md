# DEV access and notifications

The package uses the existing identity/OTP service, AES-256-GCM outbox, Resend
adapter, idempotency keys, leases and authenticated provider webhook. No message
is sent to a current customer by this DEV worker. Its DB capability includes at
most four recipient hashes and only owner-enrolled synthetic QA cases.

## Configuration boundary and historical investigation

The original September 9 configuration investigation inspected process, Windows User/Machine scopes,
relevant checkout/private environment files and the same Vercel project's global
Development/Preview and branch Preview settings. No Resend key, configured sender,
webhook secret or notification encryption key was found. The first User/Machine
inspection command failed; a separate successful inspection confirmed absence.
The connected account profile identifies an owner-controlled inbox privately,
but at that checkpoint no real email had been sent. Sender DNS could not be verified without a
configured sender; it is not reported as a diagnosed DNS fault.

Required secret/settings names, supplied outside Git:

- `TIVDOC_NOTIFICATION_PROVIDER=resend`, `RESEND_API_KEY`,
  `TIVDOC_NOTIFICATION_FROM` for an authorized verified sender.
- `TIVDOC_NOTIFICATION_OUTBOX_ENABLED=true` and one shared random 32-byte
  base64 `TIVDOC_NOTIFICATION_ENCRYPTION_KEY` for both API and managed worker.
- `DELIVERY_RECIPIENT_ALLOWLIST` with only the exact owner-controlled test
  recipient(s). Preview still enforces this under `NODE_ENV=production`.
- The worker's existing exact DEV configuration and capability, with matching
  `notification_recipients` hashes provisioned by the owner. The worker cannot
  grant itself recipients, enroll cases, create sessions or mark orders paid.
- `TIVDOC_MANAGED_DEV_NOTIFICATION_ORIGIN` for the verified HTTPS Preview URL.
- For actual delivery confirmation: `TIVDOC_NOTIFICATION_WEBHOOK_ENABLED=true`,
  `RESEND_WEBHOOK_SECRET`, and `TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL` for
  the exact isolated DEV worker role/database with `sslmode=verify-full`.
  Preview additionally requires the release branch and DEV Supabase project.
  The customer web role is never used as a fallback for this worker RPC.

Apply schema127 (`20260909155945_automatic_dev_notification_snapshot.sql`) before
enabling this code. Do not point any of these settings at Production. Provision
Resend's webhook to `/api/notifications/resend` on the test deployment only after
the sender, receiver and signature secret are configured. Deployment protection
must also permit that authenticated provider request; no protected Preview
webhook ingress had been proved at that original checkpoint. The later proof
and the current package's boundaries are distinguished below.

## Meaning of states

| Evidence | What it proves |
| --- | --- |
| `queued` | An encrypted intent was durably created, before provider access |
| `provider_accepted` / historical DB `sent` | Provider returned a message ID; delivery remains unconfirmed |
| `delivered` | The stored provider ID received a verified delivery event |
| retry/uncertain | No delivery claim; the same content/idempotency key is reused within its expiry |
| `dead_letter` | Expired, superseded, suppressed or exhausted work cannot be sent automatically |

The managed pass generates notifications only from current unanswered source
requests, a current computed DEV run, or the exact published canonical QA record.
Case/identity/recipient snapshots are rechecked after locking before ciphertext
is saved. Claim rechecks source freshness and authorization. A changed source
scrubs unsent stale intents; an email already accepted by a provider cannot be
retracted. Its protected report link still resolves under the current case
identity and retains historical/current labeling in the report view.

Each tick queues at most ten saved events and claims at most two notifications.
The database caps six attempts per delivery and thirty attempts per capability
per UTC day, 120 in total. Provider timeout is ten seconds; outbox TTL stays
inside the provider's idempotency window. Revoking the capability or enrollment
stops later claims. Notifications have their own pass, so missing OCR credentials
do not prevent configured OTP delivery.

## Existing proof and limits

The actual DEV OTP proof uses real generated codes, encrypted storage, the access
service and existing SQL verification/session functions. It checks identity and
recipient isolation, exact retry, expired/reused codes, five-attempt lockout,
revoked access and duplicate/tampered/expired signed webhook handling. Its message
provider and webhook are explicit test implementations; neither proves a mailbox
delivery or a provider-originated HTTP request.

The scheduled proof separately covers events created by actual analysis and
questions. See the final package handoff for its eventual result and exact SHA.
Synthetic browser session cookies in that proof must not be reported as live OTP
login. At that original checkpoint a real integrated login/mailbox/notification
proof remained blocked until the configuration above was supplied and verified.

## 2026-09-11 managed package status

The later source-completion handoff records actual owner OTP, actual Resend
provider IDs, signed webhook sent/delivered events and an owner mailbox report
link. See
[`source-completions-final-handoff-2026-09-10-he.md`](source-completions-final-handoff-2026-09-10-he.md).
The owner observed some messages in Spam. This is historical live evidence, not
proof of this new package's delivery or broad inbox placement. The only current
authorized destination is `tivdoc.com@gmail.com`; no customer mailing is enabled.

The ordinary managed iteration now runs notification delivery independently of
an OCR configuration/budget hold, then reads safe operational health. Abort is
checked before queuing/claiming and before provider send. If interruption arrives
during claim, the lease is retained and no send is attempted. If a request is
already in flight, its acknowledged outcome is durably finished before the loop
stops; no second claim is made. The event contract rejects a request event with
a report ID, or a report event with a request ID. These checks supplement the
existing SQL current-source, identity, recipient, expiry and idempotency fences.

The existing protected-Preview ingress is reusable without exposing the whole
Preview: a temporary localhost relay accepts only bounded POST `/api/resend`,
verifies the original Svix signature, and forwards unchanged bytes/signatures to
the exact immutable deployment's `/api/notifications/resend`. It exchanges an
expiring deployment share token for the scoped Vercel cookie, with no redirect
following. Relay TTL, request/body/concurrency limits and exact deployment
allowlist remain enforced; inherited database, provider-sending and encryption
secrets are rejected. Its only success is the application webhook's accepted
response, not a locally manufactured delivery receipt. The parent owns any
temporary tunnel/provider configuration and shutdown; no new relay activation
is claimed by this document.

Current scheduler receipts always label provider acceptance as unconfirmed
delivery. A new-package delivery claim requires the matching stored provider ID,
authenticated webhook evidence and, separately, owner mailbox observation.
Superseded or expired report events must be refused by SQL before enqueue/claim;
the report endpoint independently checks current source and authority validity.
No retry or operational label grants legal authority or converts a stale report
into a current one. The new package's actual expiry/late-event integration proof
must be supplied by its final receipt; local interruption tests alone do not
prove those database behaviors.
