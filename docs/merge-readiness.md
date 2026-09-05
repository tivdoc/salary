# Merge readiness — `claude/v0-10-2b-full-parallel` into `main`

*Long run 10, L10-2 (D2). One page for the person who decides. Every claim
carries the hash of the receipt or file it rests on. Generated from receipts
at head `19ccf7d`; nothing here is a merge, a deploy or a recommendation.*

## What a merge would change for the live site

`main` (`b963844bdcc1c3192f24516c9154a00a5f1ac0e9`, 2026-08-28) is an ancestor
of this branch: `git rev-list --left-right --count main...HEAD` = `0 421`.
A merge is a fast-forward of 421 commits, 1,181 files, +226,796 / −19 lines.
What the live site would get:

| change | what it is | proof |
|---|---|---|
| **The capability split** | the 27 dispatcher roots assigned once, as data, to a product half (20: everything `main` serves) and an engine half (7: operations, portal, the registrar); nothing unassigned, a new route fails the split test | `src/server/platform/capabilities/route-split.ts` sha256 `542eee4d5355baf22b11b7e87ca4de8cde776ecda810fddfd41c800a9caedd5c`; its test `82c95c4f…` |
| **The closed projection** | under `VERCEL_ENV=production` or `preview` `register()` installs a projection with all 18 capabilities blocked; the product half is served as `main` serves it (no capability consulted, no limit applied, the route's own code deciding); the engine half answers the product's one empty 404 | `src/instrumentation.ts` `a57ac416bded3bbf19b0d848c9cebb5899b9ebdbad203c5f1879e4b6f9c6908a`; `closed-production-runtime.ts` `7e814e852497b0a921d7d21b9f12080b203c17ac590e24e8180586985dde3745`; runtime `072b8ecd…` |
| **The routes whose handlers moved** | none moved. Each of the 20 route files `main` carries differs on this branch by the guard alone: `+3/−1` on the ten pages, `+7/−0` on eight API routes, `+8/−1` on `/api/cases/resume`, `+10/−1` on `/api/health` (the guard and a runtime constant); no file `main` carries is deleted | `git diff --numstat main HEAD -- <route>`; the split test asserts ≤12 added / ≤2 removed and no engine import per file |
| **New runtime dependencies** | `pg 8.23.0`, `pdf-lib 1.17.1`, `sharp 0.35.3`, `openai 7.8.0` (and two dev: `@playwright/cli`, `@types/pg`); installed at build, reachable from the engine half only — no product route imports them and the module-graph scan finds no provider marker in any server chunk; `openai` is present in the build with zero call paths from the product half | `package.json` deps 6 → 10; closure receipt check `module_graph_carries_no_script_or_reference_tenant_marker` (10 markers, 0 hits) |
| **The instrumentation trace** | the deployment file trace of a production build names 61 git-tracked repository files beyond `node_modules`; 9 are scripts, named as data by the entry-point inventory, none bundled, each refusing a production environment; 0 customer paths tracked (2,193 further paths named by local evidence indices are untracked and cannot deploy) | closure receipt at `6a99bb7` `98f1066f478ef906fd6f07c11cc05c1169b0d3ac14902ad68191b169cbbe3b02`, checks `deployment_trace_carries_no_customer_material_that_could_deploy`, `scripts_in_the_deployment_trace_are_data_references_that_refuse_production` |
| **The new workflow** | `.github/workflows/ci.yml` on every push and pull request: type check, lint, suites, build, the two-environment closure proof, the receipt kept as an artifact; `contents: read`, no secret, no database; the payments reconciliation workflow is byte-identical to `main`'s | `ci.yml` `313aba820297d94507e8409eb19853f96d10d2fed5d96d1bee5cd87888b28627`; `reconcile-payments.yml` `42e741476d36736f8b149e1035e9cf1d57c59c497053ebfb2bb32da1885dfca7` (unchanged since `main`) |
| **Migrations in the tree** | 53 SQL files under `supabase/migrations` (7 on `main`). A deploy applies none: every script refuses a production or preview environment, and the migration runner targets the isolated DEV project by guard. The production Supabase schema the product routes use is untouched by a merge | `scripts/production-refusal.mjs`; closure check `every_entry_point_refuses_by_execution` (147 spawned, 0 not refused) |

## What a merge would not change

Every route `main` serves answers, from a production build of this branch,
the status `main`'s own handler answers with: 20 probes, 0 mismatches — the
pages, robots, sitemap and the Open Graph image 200; `/api/health` 200;
`/api/cases/resume` 200; `/api/cases` and `/api/funnel/session` 400;
`/api/cases/status`, `/api/documents/sign`, `/api/documents/complete` and
`/api/payments/start` 401; `/api/payments/return` 3xx; and
`/api/payments/reconcile` **401 without its bearer, never 404** — the
five-minute cron reaches `main`'s own handler. Proven twice at the same head:
on this machine (receipt `98f1066f…`, builds `21138a9e…` production /
`f4d0b688…` preview) and on a clean Ubuntu runner by GitHub Actions run
33954823347 (receipt `635a8cd4732aedd63ab5c31d51282faaa6b100613ce1f5ab3e1d0bc828aeb55c`).
The product routes' own code is `main`'s: no capability, no limit and no
body read sits in front of it. The expectations the probes carry were read
from `main`'s handlers, not typed from memory.

## What a rollback is

`git revert -m 1 <merge commit>` on `main`. `main` at `b963844` is an ancestor
of everything on this branch, so a revert restores its tree exactly; there is
no migration to reverse (none is applied by a deploy) and no data written by
the engine half in production (it is blocked by construction). The platform
that serves `main` redeploys on the revert as it does on any push to `main`.

## What remains gated, and by what no deploy sets

| gate | how it refuses today | proof |
|---|---|---|
| customer processing, customer shadow, production delivery | off by default; the durable local runtime refuses to start unless each is `"0"`; the closed projection enables none of the 18 capabilities | refusal matrix, 43 rows, all refusing (`customer-refusal-matrix.test.ts` `64337879…`) |
| the durable local runtime, the hermetic runtime | refused under `VERCEL_ENV` production or preview | `DURABLE_LOCAL_PRODUCT_REMOTE_RUNTIME_FORBIDDEN`, `BROWSER_RUNTIME_BOOTSTRAP_ENVIRONMENT_FORBIDDEN` (closure checks `durable_runtime_refuses_vercel`, `hermetic_runtime_refuses_vercel`) |
| portal and operations route flags | refused under Vercel when on; disabled when off | `STABLE_PRODUCT_REMOTE_RUNTIME_FORBIDDEN` (check `product_route_flags_refuse_vercel_when_on`) |
| the offline shadow flags | throw under production with any flag on | `SHADOW_TEST_OR_OFFLINE_MODE_FORBIDDEN_IN_PRODUCTION` (check `shadow_flags_throw_under_production_with_any_flag_on`) |
| the reference catalogue, Pool P, the shadow runner, the sensitivity runners | absent from every server chunk of a production build; every script entry point refuses by execution | closure checks `module_graph_carries_no_script_or_reference_tenant_marker`, `every_entry_point_refuses_by_execution` |
| a legal figure reaching a customer | 0 active parameters, 0 active rules, 0 attestations, 0 findings; every shadow output a `synthetic_shadow_delta` | counters in every receipt since long run 7; package v12 manifest `9d96a71a…` |

## What is not proven here

The proof runs a production build on loopback with no configuration. It does
not run on Vercel's own infrastructure, does not exercise `main`'s handlers
with valid credentials (Supabase, Invoice4u, GA4, Meta), and does not prove
the platform's behaviour on a revert. A preview deployment the platform
created for the branch is behind its login and was not probed beyond that.

## Decisions that are the owner's, not engineering

1. **Open the pull request from `claude/v0-10-2b-full-parallel` into `main`, or not.** A merge puts on tivdoc.com a build that serves the product as `main` does and carries the engine closed. Nothing engineering-side blocks it; nothing engineering-side requires it.
2. **Keep the Vercel project's branch previews on, or not.** Every push to the branch creates a protected preview (every path answers a 302 to the platform's login). They are closed builds; they are also deployments the project did not ask for.
3. **Keep the repository public, or not.** `tivdoc/salary` is public; the branch carries the whole legal engine's history. A scan before the first push found no key, token, connection string, real project reference, personal address or tracked `.env` — only test fixtures and the placeholder example.
