# Preview evidence for the DEV lifecycle

The lifecycle accepts two explicitly distinguished private receipts: a retained Vercel READY response, or `tivdoc-github-preview-receipt-v1` acquired with the existing authenticated GitHub account. The latter proves a successful GitHub deployment status for the exact commit; it does **not** assert Vercel API access, Preview SSO access or browser acceptance.

From the release checkout, after pushing a clean application and waiting for its deployment:

```powershell
node scripts/product-workers/dev-preview-acquire.mjs <full-application-sha> ../release-work/<existing-private-directory>/github-preview.json
```

The command reads `tivdoc/salary` only. It selects the newest matching Preview deployment, then its newest status. A pending, failed, inactive or missing newest status cannot be replaced by an older successful status. Production, another origin, URL credentials, query parameters and non-private output directories are refused. Output is created exclusively; retries must use a new receipt filename and never rewrite a historical receipt.

Build the matching managed worker with `node src/server/product/processing/managed-worker-build.mjs` after freezing and committing the application. Do not substitute the separate saved-draft CLI bundle or the synthetic proof build.

Set the existing private lifecycle configuration's `previewReceiptPath` to this file. The documented `prepare`, `status`, `start`, `pause`, `stop` and `resume` commands remain the interface. Preparation and direct start check the clean worker manifest's exact application SHA and bundle bytes. New epochs pin the configuration, environment template, worker manifest, bundle and deployment receipt. Repeating an epoch with a different build or configuration refuses with `DEV_EPOCH_RETRY_MISMATCH`; stop the previous epoch and prepare a new ID. Historical epochs without these pins likewise require a new ID for preparation/start; status/pause/stop remain available. Notification toggles do not rewrite these pins or grant new calculation authority.

This receipt grants no machine capability, calculation authority or provider budget. No SSO bypass token is collected or distributed. It records the deployment status at acquisition time; it is not a continuous cloud health probe.

For application `0be14228b2389ec50149f1b60c8fb88342e71e01`, the actual read-only acquisition returned deployment `6409718849`, status `18262632558`, receipt SHA `1e3eadc672e033d79cf6f3288cfeab89ef9715c078e35c8229a0b99f3af04d6c`. Browser access remained unproven: the matching Preview redirected to Vercel login. This is a historical acquisition proof, not evidence that later application changes were deployed or that the managed worker ran.

Focused receipt/lifecycle verification passed 24 tests. Actual lifecycle preparation with this new receipt kind and the final release build remains part of integrated DEV acceptance. Production is unchanged.
