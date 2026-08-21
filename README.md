# Tivdoc Salary

Hebrew RTL MVP for the Tivdoc Salary validation funnel:

`Landing → questionnaire → private document upload → Invoice4u hosted payment → verified status`

The project intentionally does not include OCR, a salary-law engine, AI analysis, user accounts, dashboards or the future ₪99 report product.

## Stack

- Next.js App Router, React and TypeScript
- Native CSS with Tivdoc design tokens
- Supabase Postgres and private Storage
- Invoice4u hosted payment adapter
- GA4 event tracking
- Vitest for validation and payment-state tests

## Local setup

Requirements: Node.js 20.9 or newer and npm.

```bash
npm install
cp .env.example .env.local
npm run dev
```

On PowerShell, copy the environment template with:

```powershell
Copy-Item .env.example .env.local
```

The landing page and static routes run without external credentials. Creating a case, uploading documents and starting payment require the matching server environment variables.

## Environment variables

| Variable | Visibility | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase project URL for project `hedgdltsonvypefbigag` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Uploads documents with a short-lived signed upload token; it cannot read case tables |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only | Route-handler access to private case data and Storage |
| `CASE_TOKEN_SECRET` | Server only | Signs the HttpOnly case cookie; use at least 32 random characters |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Public | GA4 measurement ID |
| `INVOICE4U_PAYMENT_URL` | Server only | Existing Invoice4u hosted payment-page URL |
| `NEXT_PUBLIC_SITE_URL` | Public | Canonical site URL, for example a Vercel Preview URL |

Generate a case-cookie secret locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never expose `SUPABASE_SERVICE_ROLE_KEY` or `CASE_TOKEN_SECRET` through a `NEXT_PUBLIC_` variable.

## Supabase

The reproducible schema is in `supabase/migrations/202608220001_salary_mvp.sql`.

Apply it to project ref `hedgdltsonvypefbigag` using the Supabase CLI or the SQL editor. With the CLI:

```bash
supabase link --project-ref hedgdltsonvypefbigag
supabase db push
```

The migration creates:

- `cases`, `questionnaire_responses`, `documents` and `payments`
- the private `salary-documents` bucket with PDF/JPEG/PNG and 10MB-per-file limits
- RLS on every product table with no anonymous or authenticated policies
- explicit service-role grants while `anon` and `authenticated` remain revoked and blocked by RLS
- `private.mark_salary_case_paid(case_id, provider_reference)` for a verified/manual payment transition

Case metadata goes through server Route Handlers using the service role. The browser receives only a public case reference; the internal case ID remains in a signed HttpOnly cookie. For upload, the server issues a two-hour Supabase signed upload token scoped to one fixed object path. The browser uploads directly to private Storage and the server verifies the resulting objects before registering them. No permanent public Storage URLs are generated.

Object paths follow:

```text
cases/{case_id}/payslip-01.pdf
cases/{case_id}/contract.pdf
cases/{case_id}/attendance.pdf
```

The schema is ready for a later retention job because every object is scoped under its case UUID. No automatic deletion claim is made until that job and a retention period are implemented.

## Invoice4u hosted payment

Set `INVOICE4U_PAYMENT_URL` to the existing hosted page. The server creates a pending `payments` row and updates the case to `payment_pending` before returning the handoff URL.

Configure the hosted page to return to:

```text
https://YOUR_DOMAIN/api/payments/return
```

The return route only redirects to `/check/received`. It never marks the case as paid. The received page reads the database and shows either verified processing or pending verification.

For the manual-review validation phase, verify a successful Invoice4u transaction and run the protected database function from an authorized server or the Supabase SQL editor:

```sql
select private.mark_salary_case_paid(
  'CASE_UUID_HERE'::uuid,
  'INVOICE4U_REFERENCE_HERE'
);
```

Before replacing the hosted page with the Invoice4u API, implement its documented signed webhook/callback inside the payment adapter and call the same database transition. Do not accept browser query parameters as proof of payment.

## Analytics

GA4 is loaded only when `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set. Implemented events:

- `landing_view`
- `start_check`
- `questionnaire_started`
- `questionnaire_completed`
- `payslip_uploaded`
- `payment_started`
- `payment_completed` (only after the API reports a verified payment)
- `hero_inspector_interaction`
- `mini_demo_completed`
- `faq_opened`
- `upload_error`
- `payment_returned`

## Quality checks

```bash
npm run lint
npm test
npm run build
```

`GET /api/health` returns configuration booleans without exposing values or secrets.

## Vercel Preview

1. Import `tivdoc/salary` into team `tivdoccom-5042s-projects` (`team_ATajnGzbAqDUrrrIoUlCzM4b`).
2. Add all environment variables to Preview. Use the Preview deployment URL for `NEXT_PUBLIC_SITE_URL` on the first run.
3. Apply the Supabase migration before testing the funnel.
4. Configure the Invoice4u hosted-page return URL for the Preview deployment.
5. Deploy and verify the complete mobile funnel with a non-sensitive fictional payslip.
6. After Preview approval, add `tivdoc.com` in Vercel and update the Cloudflare DNS record requested by Vercel.

The `/privacy` and `/terms` routes contain safe placeholder structures and visibly mark the legal details still required before a public Production launch.
