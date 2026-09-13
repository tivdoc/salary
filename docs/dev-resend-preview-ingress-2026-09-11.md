# DEV Resend Preview ingress: operator and verification boundary

## 2026-09-13: one share per Hobby account

The actual team reports the Hobby plan. [Vercel documents one sharable link per Hobby account](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links). The old operator successfully probed its forwarding share, then created a second ingress probe share. The forwarding exchange subsequently returned302 locally and in the deployed handler, before the application received the webhook. The second share invalidated the first; this was an operator defect, not evidence that cloud forwarding requires a different receiver.

Enable now retains the single forwarding share, checks the protected main application, opens only the scoped ingress override, verifies405/404/401 with bounded propagation, and probes forwarding again before recording success. A failed boundary or forwarding probe rolls back the override. Legacy probe-share cleanup and exact404 reconciliation remain available.32 focused tests passed, including a transport that invalidates the first share on a second creation. This is local regression evidence; successful live provider reception still requires its own receipt. Creating another share in this account can interrupt forwarding and must be coordinated.

Package base: `e52d320`. This document describes the bounded implementation and local evidence. The final handoff must add the commit actually built, deployment receipt and real provider evidence; these are not implied by the tests below.

The ingress artifact exposes only `POST /api/resend`. It checks the original Svix signature and size, exchanges its own expiring share for a cookie scoped to one immutable application Preview, and forwards the unchanged signed payload to `/api/notifications/resend`. The application independently verifies the signature and saves the provider event through its existing RPC. No receiving event authorizes sending a message. No tunnel is involved.

## Why the existing salary project is used

The dedicated `tivdoc-dev-resend-ingress` project has no Production baseline. Vercel documents that a project's first deployment is classified as Production even if Preview was requested. Do not repeat the previous attempts against that empty project under a no-Production instruction. [Vercel environments](https://vercel.com/docs/deployments/environments#first-deployment).

The existing `salary` project already has a Production baseline. A prebuilt, ingress-only artifact can be submitted without changing its project settings. The operator omits `target` exactly as the installed CLI does for Preview, and rejects a Production response. It also compares the Production deployment ID and existing framework/runtime/build/protection settings before and after deployment and before enabling ingress. [Build Output API](https://vercel.com/docs/build-output-api), [CLI deploy](https://vercel.com/docs/cli/deploy).

The operator uses only project `prj_kmqJ74IuBrc5hI9J93RpcUkNMBW7`, team `team_ATajnGzbAqDUrrrIoUlCzM4b`, and a caller-pinned READY application Preview on `codex/tivdoc-release-completion`. It never changes the main project's protection policy or branch alias.

## Local commands

Use the release repository as the working directory. The config must be an existing private JSON file **outside the repository**. It contains these fields:

```json
{
  "schema_version": "dev-ingress-operator-v1",
  "vercel_cli_path": "ABSOLUTE_PATH_TO_EXISTING_AUTHENTICATED_VERCEL_CLI_INDEX_JS",
  "main_preview_id": "EXACT_READY_APPLICATION_DEPLOYMENT_ID",
  "main_preview_commit": "EXACT_40_HEX_APPLICATION_COMMIT",
  "resend_webhook_secret": "PRIVATE_RESEND_WEBHOOK_SIGNING_SECRET",
  "expires_at": "EXPLICIT_UTC_PACKAGE_DEADLINE"
}
```

These are placeholders, not usable credentials. Reuse the already authenticated CLI and owner-provided webhook signing secret. Do not search for or print new credentials. The operator refuses a Vercel/Production process before it reads this file.

After committing the intended code and verifying a clean release branch:

```powershell
node scripts/product-workers/build-dev-ingress.mjs
node scripts/product-workers/dev-ingress-deploy.mjs deploy --config <PRIVATE_CONFIG_PATH>
node scripts/product-workers/dev-ingress-deploy.mjs status --config <PRIVATE_CONFIG_PATH>
node scripts/product-workers/dev-ingress-deploy.mjs enable --config <PRIVATE_CONFIG_PATH>
```

The operator does not poll a build until completion. If the status is BUILDING, use `status` again after it changes, then `enable`. Do not repeat `deploy` with the same state. Only the root/operator performs remote commands; unit tests use explicit synthetic API and HTTP ports.

`build-dev-ingress.mjs` retains its old bundled output and adds three prebuilt files under `output/release-completion/dev-resend-ingress/prebuilt`:

- `.vercel/output/config.json`: filesystem route followed by 404.
- `.vercel/output/functions/api/resend.func/.vc-config.json`: Node 24, no request helper/body parser, 30-second bound.
- `.vercel/output/functions/api/resend.func/index.js`: bundled ingress only.

Only these three files are uploaded. The operator checks the clean Git HEAD, build input hashes, bundle hash, fixed routing and runtime configuration. It sends no `projectSettings`, `gitSource`, Git metadata or application alias.

## Credential and protection boundaries

The operator reads project env metadata with `decrypt=false` and shared env metadata filtered to this project. It blanks **every inherited key** in the deployment's runtime `env`, then supplies only `RESEND_WEBHOOK_SECRET` and the four ingress flag/share/origin/expiry settings. These overrides belong to the new deployment, not future project builds. Function `.vc-config.json.environment` alone is insufficient because Vercel adds it to project variables. [Function environment contract](https://vercel.com/docs/build-output-api/primitives#base-config), [Vercel maintainer explanation of per-deployment overrides](https://github.com/vercel/vercel/discussions/9295).

The receiving runtime separately refuses nonempty application/credential namespaces before even returning GET 405. It exposes only `credential_scope_violation`, never names or values. Vercel/AWS platform runtime variables remain available; this is not a claim that the platform injects no credentials. Unknown ordinary system variable names are not exhaustively classified by the guard, so the complete metadata inventory and blanking remain necessary.

Before opening the ingress, `enable` obtains its own temporary share and checks GET `/api/resend` through the protected deployment. A 405 proves the artifact's runtime application-credential guard passed. The operator then applies the exact deployment exception:

```text
PATCH /aliases/<INGRESS_DEPLOYMENT_ID>/protection-bypass?teamId=<PINNED_TEAM>
{"override":{"scope":"alias-protection-override","action":"create"}}
```

It verifies public ingress GET 405, unrelated path 404, unsigned POST 401 and continued protection of the main Preview. A failed boundary probe triggers revocation of the ingress exception. It never calls the project-wide automation bypass endpoint. [Official API schema](https://openapi.vercel.sh/), [domain exception semantics](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/deployment-protection-exceptions).

Only after these checks should the owner configure Resend to send to the returned immutable ingress origin plus `/api/resend`. That provider configuration and an actual supplier-signed delivery remain separate proof steps; the operator does not send mail or configure Resend.

## Stop, restart and uncertain calls

The owner disables the corresponding Resend callback as appropriate, then:

```powershell
node scripts/product-workers/dev-ingress-deploy.mjs disable --config <PRIVATE_CONFIG_PATH>
node scripts/product-workers/dev-ingress-deploy.mjs status --config <PRIVATE_CONFIG_PATH>
```

`disable` revokes only this ingress deployment's exception and its own two shares (main forwarding share and temporary ingress probe share). It does not remove someone else's share, a project bypass, the main protection policy, or any deployment. Already expired shares are recorded as expired, not falsely reported as actively revoked. The returned public-status check distinguishes a requested disable from observed protection.

The private state is saved beside the config as `<config>.state.private.json`; private mutation requests/responses are also kept there. Public status is redacted at `output/release-completion/dev-resend-ingress/operator-status.json`. A lost response leaves a durable pending mutation and blocks a blind deploy/enable retry. Reconcile the exact private request/response and Vercel operation first; `disable` remains available for known pinned resources. A process crash can leave the exclusive `.lock` file: confirm the prior operator process has exited before removing only that lock. Never erase the receipt to force a redeploy.

`status` is read-only. A stopped or expired share cannot be restarted by extending its timestamp. A new explicitly authorized bounded package must supply a new config/state and deadline, a current verified main Preview and a new scoped share. Provider/OCR budgets and worker/authority state are independent and must not be reset by this tool.

### Reconcile one already-absent share after STOP

If override revocation succeeded but the following share revoke returned the exact Vercel error `The specified shareable link does not exist. (404)`, do not repeat `disable` blindly. Keep both private response files and their matching request files, and run:

```powershell
node scripts/product-workers/dev-ingress-deploy.mjs reconcile-absent-share --config <PRIVATE_CONFIG_PATH> --receipt <EXACT_MISSING_SHARE_RESPONSE_PRIVATE_JSON> --override-receipt <EXACT_SUCCESSFUL_OVERRIDE_REVOKE_RESPONSE_PRIVATE_JSON>
```

This performs no remote mutation. It matches the saved missing-share request, secret and hash to the pending operation, requires the successful override-revoke receipt for the pinned ingress deployment, and checks that the ingress is currently protected. A generic 404, another deployment/share, remaining override or public ingress is refused. It records the link as **absent**, preserves the receipts and reconciliation history, clears only the matching pending operation, and marks local state disabled. It never calls this an active share revocation.

## Local evidence and remaining external proof

| Check | Evidence in this package |
| --- | --- |
| Malformed UTF-8 signature confusion | Reproduced before fix: existing ingress returned 200 instead of 401; 18 passed / 1 failed. Both receiving paths now use fatal UTF-8 decoding without replacing bytes or stripping BOM. |
| Raw Hebrew/whitespace, body size, event-ID bounds, old occurrence with fresh signature, duplicate coordinates | Webhook unit contracts pass. No supplier call. |
| Application persistence error / replay mismatch not acknowledged; isolated Preview DB does not fall back | Route tests pass with an explicit mocked store. This is not DB event-correlation proof. |
| Ingress forwarding, runtime credential refusal, historical local/Preview guards | Six focused files, 73/73 passed; changed-file lint passed. Local relay was not started. |
| Operator no-Production/main-scope guards, empty inherited overrides, protected probe, exact exception, rollback, expiry, uncertain retry | 16 focused synthetic operator tests passed; operator lint passed. No remote mutation by the test. |
| Real deployment and provider callback | Must be supplied by the root's actual operator receipt and live Resend/DB evidence. Not proved by this document or by a locally signed test event. |
| Early receipt before provider acceptance, duplicate event, delayed delivery correlation | Existing SQL keeps receipt identity and applies early events when acceptance is recorded. Actual DB/provider evidence for the current package must be reported separately. No SQL was changed in this lane. |
