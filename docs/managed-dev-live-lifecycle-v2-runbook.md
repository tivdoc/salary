# Bounded live extraction in the ordinary DEV lifecycle

The existing `scripts/product-workers/dev-lifecycle.mjs` command now accepts an additive `managed-dev-live-lifecycle-v2` configuration. The original `managed-dev-lifecycle-v1` remains receipt-only. Both use the same managed worker, scheduled task, saved source journal, claim, extraction checkpoint and report pipeline. This document describes operation; it is not an authorization to spend, issue a configuration, or activate REAL service.

## Inputs and boundaries

Run from the exact frozen checkout used to build the worker manifest. Supply a reviewed Preview receipt, the existing verified owner/isolated QA case, a fresh applicable owner-engineering configuration/enrollment, and a separate explicit machine window of at most four hours. Machine preparation does not extend source reviews, configuration validity or purchase coverage.

V2 retains every v1 lifecycle field and adds:

```json
{
  "version": "managed-dev-live-lifecycle-v2",
  "liveAuthorization": {
    "templatePath": "<absolute private template file>",
    "templateSha256": "<SHA256 of exact template file bytes>"
  }
}
```

The template is `managed-dev-live-lifecycle-template-v2`, with an explicit `epochId` equal to the CLI epoch argument and a `permit` conforming to `sol-managed-live-window-v2` except for `capabilitySha256`. It pins the actual case, uploaded version, file hash/size/type, code build, original ledger and baseline prefix, exact acknowledged unknown-cost receipts, authorization ID and fixed window. It permits at most two content requests and one generation within a 712000 micro-USD additional reserve; recovery and retries are disabled. This is a bound on the existing ledger, not a reset or replacement budget.

The currently supported policy revalidation is explicit R7 first-pass to R8 first-pass with its authentic prior receipt. A private factual source snapshot or retained response cannot replace the normal worker's current case/version/source checks. Separate attendance or contract files are outside a payslip-only permit.

Private worker environment templates may contain credentials. Keep their contents out of command arguments, logs, reports and Git. V2 requires the existing OpenAI key in that private template and enables the bounded managed factory; V1 removes provider access. Both generated environments disable notifications. Do not copy credentials into the live permit.

## Existing commands

Use one stable UUID for an epoch and retain its config, template, permit, ledger and generated control files:

```powershell
node scripts/product-workers/dev-lifecycle.mjs prepare '<private lifecycle config>' '<epoch UUID>'
node scripts/product-workers/dev-lifecycle.mjs status  '<private lifecycle config>' '<epoch UUID>'
node scripts/product-workers/dev-lifecycle.mjs start   '<private lifecycle config>' '<epoch UUID>'
node scripts/product-workers/dev-lifecycle.mjs pause   '<private lifecycle config>' '<epoch UUID>'
node scripts/product-workers/dev-lifecycle.mjs resume  '<private lifecycle config>' '<epoch UUID>'
node scripts/product-workers/dev-lifecycle.mjs stop    '<private lifecycle config>' '<epoch UUID>'
```

`prepare` checks the owner/QA enrollment and stopped predecessor, generates the epoch capability once, and binds the exact permit to that capability. The epoch is saved before its permit so an interrupted preparation recovers the same capability. It creates a disabled task and does not make a provider call. SQL stores `provider_policy=sol_managed_live_window_v2` and the immutable permit file hash in `provider_authorization_sha256`; receipt-only rows retain a null authorization hash.

`start` enables the existing managed task. This is the action that may lead to the authorized count and generation through the ordinary worker. The source, capability, model, ledger, permit and windows are checked before content requests. A pending or failed request is not free capacity and does not justify replaying content.

`pause` disables scheduling/capability use without erasing history. `resume` may reuse only the same still-valid, non-revoked epoch and remaining original budget. It cannot renew authorization, replace the source or move to a new build. `stop` additionally revokes the machine session. A stopped/revoked or expired epoch requires explicit fresh preparation with a new ID and valid evidence; it cannot be revived by changing the clock or a file's expiry.

Shutdown authenticates the immutable case, owner, epoch, session, capability and configuration identity, then commits the machine disable/revocation before local scheduler actions. Missing or changed extraction permits, budget ledgers, build artifacts or supervisor files are recorded as shutdown warnings; they cannot prevent durable disable. A local scheduler failure is reported separately. This does not relax `prepare`, `start` or `resume` validation. Preserve the shutdown receipt and verify durable disabled/revoked state even when a local warning remains.

`status` reports the existing worker and authority state. It does not certify a successful analysis or report. Check the actual saved job/result/report linkage separately. A historical report remains historical after a new epoch is prepared.

The `authority` fixture command and `notifications-resume` are refused for V2. There is no human-law decision, legal-debt total or permission to notify a customer implied by live extraction. All purchased topics remain present; missing facts, methods and source reviews retain their own blocking outcomes.

## Ledger and recovery

V1 continues to require byte-identical ledger state. V2 validates the original immutable prefix and permitted append transitions through the existing managed live ledger validator. Retained local `dev-live-ledger-<epoch>/` watermarks detect shrinking or rewriting the ledger across commands. They are evidence of observations, not a new budget. Do not delete those files to recover capacity.

Keep every failed preparation/test/worker receipt. A retry must use unchanged config/build/template/permit bytes and the same epoch. If a source or configuration changes, prepare a separately authorized run; do not rewrite old receipts or silently rebind a response to a different uploaded version.

Before operational use, complete the focused lifecycle/factory checks and the existing SQL rollback checks against the intended DEV schema. Passing synthetic checks is distinct from an actual saved case run. No command in this runbook changes the application's external service policy or authorizes REAL release.
