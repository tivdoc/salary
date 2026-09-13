# DEV provider configuration — 9 September2026

Current package starts at `2ebddb75ab8e0a6ee8beb9e50895c2929b5c1339` on
`codex/tivdoc-release-completion`. The existing Tivdoc Production application and
database were not changed. See the isolated ingress deployment incident below.
Final source/schema/deployment receipts belong in the package handoff, not this
configuration guide. Configuration is not evidence of provider delivery.

## Authorized account access

- Reused the previously connected Gmail owner profile; one private recipient.
  No customer inbox was read or contacted. No old credential-location search
  was repeated.
- Existing Vercel team access works. Its integration-installation list is empty;
  this does not establish whether standalone provider accounts exist.
- CUA account-browser inventory failed twice with `failed to write kernel assets`.
  Playwright's normal login page was used as a fallback, with all account-session
  files outside Git. Resend's login advanced from the verified owner email to a
  password step. No password reset, new account or new billing was attempted.
- The OpenAI platform API-key page returned HTTP403 / `Just a moment...` in that
  browser. No challenge bypass or unapproved account action was attempted.
- No live OpenAI request, Resend send, supplier receipt, owner OTP login or real
  delivery webhook is claimed. Gmail was checked only for the attempted Resend
  login in the current day; no matching login message arrived.

## Configuration actually written

Using the authorized existing Vercel project `salary`, the following **sensitive
branch-Preview-only** values were written by stdin, with private local copies:

- `TIVDOC_NOTIFICATION_ENCRYPTION_KEY`: securely generated32-byte AES key.
- `DELIVERY_RECIPIENT_ALLOWLIST`: the exact connected owner recipient.
- `TIVDOC_NOTIFICATION_WEBHOOK_POSTGRES_URL`: existing isolated worker-role DSN,
  `tivdoc_release_replay_20260907`, verified TLS plus the application's trusted CA.

No provider flag was enabled, no provider credential was invented, and no
Production or global Development setting was changed. Worker startup must load
the same private encryption key/allowlist; the new values reach the application
only in a newly created Preview. A stored secret does not prove runtime use.

Required provider values still absent from the authorized configuration:
`OPENAI_API_KEY`, a verified available `OPENAI_EXTRACTION_MODEL`, `RESEND_API_KEY`,
authorized `TIVDOC_NOTIFICATION_FROM`, provider-generated `RESEND_WEBHOOK_SECRET`.
The dated `gpt-4o-mini-2024-07-18` is supported explicitly by the DEV worker and
the bounded live corpus runner; no claim is made that the account has access.
The existing default model is unchanged. See the live extraction package for the
price snapshot,22-pass limit and conservative$0.5544 maximum reservation.

## Narrow webhook ingress — code prepared, public deployment blocked

The existing application remains protected. A separate project,
`tivdoc-dev-resend-ingress` (`prj_v8VNYB9JmkpvA004VSUEZmF8PlSA`), was created in the
same Vercel team for one public, signed DEV callback. It contains no DB, storage,
customer session, OpenAI credential, email-sending credential or customer UI.
Only Preview deployments are authorized for this package; the function itself
refuses `VERCEL_ENV` other than `preview`.

Two first deployments in this **new isolated project** were unexpectedly
classified by Vercel as `production`: first with the API target omitted, then
with explicit `target:'preview'`. They were immediately deleted:
`dpl_6kGtt1xyQKP9myyb1cFQbS43BRHi` and
`dpl_5ACV1ih99U6aGvy4gEUk6KR9GsLG`. Neither had provider secrets, database
credentials, enabled ingress or customer data; the handler refuses Production.
The existing salary Production project/deployment was not changed. No third
deployment was attempted. There is currently **no public supplier endpoint** in
this project. Do not claim that the Preview webhook problem is fully resolved.
The exact immutable salary Preview transport works separately with a scoped
cookie exchange. A supported Preview-only ingress deployment remains necessary.

`src/server/product/case-access/dev-resend-ingress.ts` accepts only
`POST /api/resend`, up to64KiB, and verifies the original Resend/Svix signature
before any onward request. It exchanges a short-lived share for **one immutable
salary Preview** for that Preview's Vercel cookie, then forwards the same body and
signature headers to its fixed `/api/notifications/resend` endpoint. Neither
redirects nor a request-supplied destination can receive credentials. The app
re-verifies the signature and persists/deduplicates the event. The ingress only
acknowledges the supplier after that endpoint returns `{accepted:true}`.

The ingress starts disabled. Private settings needed for activation:

```text
TIVDOC_DEV_INGRESS_ENABLED=true
TIVDOC_DEV_PREVIEW_ORIGIN=<exact immutable verified Preview origin>
TIVDOC_DEV_PREVIEW_SHARE_SECRET=<deployment-only expiring share, never project bypass>
TIVDOC_DEV_PREVIEW_SHARE_EXPIRES=<actual share expiry as an ISO timestamp>
RESEND_WEBHOOK_SECRET=<same provider signing secret configured in the app>
```

Use Vercel's documented `PATCH /aliases/{deploymentId}/protection-bypass` with a
bounded TTL after verifying deployment project, branch and non-Production target.
The deployment share alone returns307 on a direct webhook POST, so it is **not**
registered as a Resend endpoint. The two-request cookie exchange was tested with
the existing Preview71be722: it reached the application's disabled webhook503.
This is transport evidence, not a signed supplier event or delivery proof.

A first temporary share appeared in a diagnostic structure output. It was
immediately revoked and replaced; no value entered Git. Subsequent diagnostics
print only counts/status and keep all map keys private. No project-wide bypass
secret was created or changed in this package.

The share expires by design. Renew it before a bounded live test, bind the new
deployment SHA, and stop sending when it expires. Do not remove the app's
protection, use a Production origin, or reuse a project-wide bypass credential.

## Owner actions that are actually necessary

1. Supply normal authorized access to the existing OpenAI API account (including
   any interactive platform challenge) or place a DEV project key in the private
   configuration. Confirm existing credit/model access; do not open new billing.
2. Supply the existing Resend account login or an appropriately scoped credential
   for DEV sender/webhook provisioning. Sender verification/DNS status remains
   unknown until account access; no DNS fault has been diagnosed.

The connected owner destination and internal encryption key need no further owner
action. Once provider access exists, configure sender/key/webhook privately and
match API/worker/Preview, then prove real OTP, request/report emails and delivered
events. A provider's `sent` response is acceptance; only the verified event is
delivery. Never use an injected session or webhook as that proof.

Sources: [Resend API-key management](https://resend.com/docs/dashboard/api-keys/introduction),
[Vercel deployment share scope](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links),
[Vercel API schema](https://openapi.vercel.sh/).
