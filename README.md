# Beat My Quote

Homeowners in England and Wales upload a quote they already have, with photos and a video, and
vetted builders beat that price. The platform's own crews get first refusal, then partner builders.
Builders never quote: they accept the platform's beat price. Prices are in £ including VAT.

**Status: test phase, not production-ready.** See [`TECHNICAL_SECURITY_AUDIT.md`](TECHNICAL_SECURITY_AUDIT.md)
for what is implemented, tested, verified and still needs external set-up. All legal wording is a
draft for solicitor review.

## What it does

1. A homeowner signs up, enters the job and their quote total, uploads the quote, photos and a walkthrough video, ticks the consents and submits.
2. Admin reviews it, uploads a redacted copy of the quote (the original stays private), writes a standard scope and publishes it. The beat price is set 5 to 10% below the quote, never below the minimum.
3. In-house crews see the job first (24 hours by default), then approved partner builders. The first builder to accept the beat price gets the offer. The homeowner's address stays hidden.
4. The homeowner accepts the offer, which creates the Job Contract with a fixed price, and pays the deposit through Stripe.
5. The builder sees the address, records the pre-start check, and can't start until the deposit is paid and the check is confirmed.
6. The price changes only through a written variation. If the homeowner declines a variation for a hidden problem, the contract ends and the deposit is refunded in full.

## Stack

Next.js 16 (App Router, TypeScript), PostgreSQL on Supabase with row-level security, Supabase Auth
and Storage, Stripe Connect (test mode), Resend for email, Twilio for SMS, deployed on Vercel.

Every external service has a local stand-in, so the whole app runs on one machine with only Postgres:
dev sign-in, a storage emulator (signed URLs and resumable uploads), a fake payment provider that
signs webhooks in Stripe's format, and console email and SMS.

## Run it locally

Needs Node 22 and PostgreSQL 16.

```bash
npm ci
cp .env.example .env.local          # then replace the placeholder secrets with random values
createdb bmq_dev
DATABASE_URL=postgres://postgres:postgres@localhost:5432/bmq_dev npm run db:migrate -- --local-stub --dev-auth
DATABASE_URL=postgres://postgres:postgres@localhost:5432/bmq_dev npm run db:seed:dev
npm run dev
```

Seeded accounts (local only; the seed script refuses any non-local database). The password is
`TestPassword123!` unless you set `SEED_PASSWORD`:

| Email | Role |
|---|---|
| admin@bmq.test | Admin |
| homeowner@bmq.test, homeowner2@bmq.test | Homeowners |
| crew@bmq.test | Approved in-house crew |
| partner@bmq.test | Approved partner builder |
| pending@bmq.test | Builder awaiting approval |

## Checks

```bash
npm run lint
npm run typecheck
npm test                    # unit tests, no database
npm run test:integration    # creates and drops a local bmq_it database
npm run build
npm run audit:secrets       # scans the repo and built browser bundles for credentials
npm run test:e2e            # Playwright, creates a local bmq_e2e database and starts the built app
```

The same checks run in GitHub Actions on every pull request (`.github/workflows/ci.yml`), with
throwaway databases and dummy secrets.

If Playwright's own browser is not installed, point it at another Chromium with
`PW_CHROMIUM_PATH=/path/to/chromium`.

## Configuration

All settings are read once and validated in `src/server/config.ts`; see `.env.example`.

- `APP_ENV` (`development`, `test`, `staging`, `production`) controls the safety checks. In `production` the app refuses to start with dev sign-in, the storage emulator, fake payments, a missing webhook or cron secret, or a non-https origin.
- Only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are sent to the browser. **Never put the Supabase service-role key, Stripe keys or any other secret in a `NEXT_PUBLIC_` variable or in the repository.** Set them in the Vercel project settings.
- Business numbers are settings with placeholder values until decided: `SUCCESS_FEE_BASIS_POINTS` (0), `MINIMUM_JOB_PRICE_PENCE` (£500), `DEPOSIT_BASIS_POINTS` (10%), `CREW_WINDOW_HOURS` (24), `PARTNER_WINDOW_HOURS` (72), `OFFER_ACCEPT_HOURS` (72).

## Deploying (not done yet)

1. **Supabase:** create a project in the UK or EU region. Apply `supabase/migrations` with `supabase db push` (never the `--local-stub` or `--dev-auth` flags; the script refuses them for Supabase hosts). In Auth, set the site URL and the `/reset-password` redirect. The migration creates the private `job-media` bucket. Note the free tier's 50 MB file limit; videos above it will fail.
2. **Stripe:** use test mode. Enable Connect, create a webhook endpoint at `https://<domain>/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`, and set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
3. **Vercel:** set the environment variables, with `APP_ENV=production` and a long random `CRON_SECRET`. Cron jobs are listed in `vercel.json`; Vercel's free Hobby plan only runs crons once a day and is for non-commercial use, so this needs a decision (paid plan, or an external scheduler calling the cron URLs with the secret).
4. **Email and SMS:** verify a sending domain in Resend (SPF and DKIM) and a UK sender in Twilio, or keep the console providers for a closed test.
5. **Optional:** set `MALWARE_SCANNER_URL` for a ClamAV-style scanning service and `SENTRY_DSN` for error reporting. Neither is connected yet.

Health checks: `GET /api/health` (the app is up) and `GET /api/health/ready` (the database answers).

## Backups and restore

Nothing is scheduled yet. The plan:

- **Database:** a daily `pg_dump --format=custom` of the Supabase database, stored encrypted outside Supabase (for example, a private bucket with another provider) and kept for 30 days. Supabase's own backups depend on the plan; the free tier has no point-in-time recovery, so check the current terms before relying on them.
- **Files:** a weekly copy of the `job-media` bucket. Uploaded quotes and photos contain personal data, so the copy must be private and encrypted, and deleted on the same schedule as the originals.
- **Restore:** create a new Supabase project, `pg_restore --no-owner --dbname=<new url> backup.dump`, copy the bucket back, point `DATABASE_URL` and the Supabase keys at the new project, then run `GET /api/health/ready` and the cron task `reconcile-payments` so payment states are re-checked with Stripe.
- **Rehearse a restore** into a scratch project before launch and at least every quarter. This has not been done.

## Where things are

| Path | What |
|---|---|
| `src/app` | Pages and API routes |
| `src/components` | Forms, uploader, API client |
| `src/server/http/handler.ts` | The wrapper every API route goes through (CSRF, auth, roles, rate limits, validation, idempotency, errors, logs) |
| `src/server/services` | Business rules |
| `src/server/domain` | Pricing, job state machine, file checks, retries |
| `supabase/migrations` | Database schema, RLS policies, triggers |
| `tests/unit`, `tests/integration`, `tests/e2e` | Tests |
| `scripts` | Migrate, seed (local only), secrets check |
