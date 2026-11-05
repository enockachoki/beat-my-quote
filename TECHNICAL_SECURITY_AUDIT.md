# Beat My Quote: technical and security audit

Date: 5 November 2026. Scope: the first version of the platform in this repository.

**This application is not production-ready.** It builds, and the tests below pass against local,
disposable databases with fake providers. It has not run against a real Supabase project, real
Stripe test keys, Resend or Twilio, and nobody outside the build process has tested it. Legal
wording in the app is a draft for solicitor review.

Every item below is labelled:

- **Implemented**: the code exists.
- **Tested**: an automated test exercises it, and the test passes.
- **Verified**: checked by running the real app in a browser (Playwright), beyond unit tests.
- **Needs external configuration**: it depends on a service or setting outside this repository that has not been set up.

---

## 1. Architecture

| Layer | Where | Notes |
|---|---|---|
| Pages (React Server Components and client forms) | `src/app`, `src/components` | Next.js 16 App Router, strict TypeScript. Every protected page calls `requirePageUser` and loads data through the same services the API uses. |
| Edge proxy | `src/proxy.ts` | Per-request nonce CSP, request ID, rejects CORS preflights (405). |
| API routes | `src/app/api/**/route.ts` (42 routes) | All wrapped by `route()` in `src/server/http/handler.ts`. |
| Request wrapper | `src/server/http/handler.ts` | CSRF origin check, authentication, role check, rate limit, JSON size cap (64 KB), schema validation, idempotency, error mapping, structured logging. |
| Services (business rules) | `src/server/services` | Ownership checks, transactions, row locks, audit entries, notification outbox. |
| Domain (pure logic) | `src/server/domain` | Pricing, job state machine, variations, file sniffing, timeouts and retries. Unit-tested without a database. |
| Repositories | `src/server/db/repositories` | SQL only. Parameterised through the `postgres` driver's tagged templates. |
| Providers (swappable) | `src/server/{auth,storage,payments,notifications}` | Dev/fake providers for local and test; Supabase, Stripe, Resend and Twilio providers for real use. |
| Database | `supabase/migrations` | Postgres with row-level security, constraints, triggers, an append-only audit log. |

Data flow for a protected write: browser → proxy (CSP, request ID) → `route()` (CSRF → session → role → rate limit → body schema → idempotency) → service (ownership check, transaction, `FOR UPDATE` lock, state transition, audit, outbox) → database (constraints and triggers enforce the same rules again).

The server connects as the database owner and performs authorisation in TypeScript first. Reads that return a user's own data also run inside `withUserTx`, which sets the user's JWT claims and switches to the `authenticated` role, so RLS applies as a second check. The browser never talks to the database directly; the `anon` and `authenticated` roles have SELECT only, through RLS, and no write grants at all.

## 2. Security controls

| Control | Status | Where / how |
|---|---|---|
| Authentication on every non-public endpoint | Implemented, tested, verified | `route({ auth })`; E2E `security.spec.ts` |
| Role checks (homeowner, builder by kind and status, admin) | Implemented, tested, verified | `src/server/authz/policies.ts`; unit `policies.test.ts`; E2E checks a homeowner can't reach admin pages or APIs and a pending builder can't take jobs |
| Ownership checks (a homeowner sees only their own jobs) | Implemented, tested, verified | Services plus RLS; E2E checks another homeowner gets "not found" with no data, and the API returns 404 |
| Address hidden until the homeowner accepts an offer | Implemented, tested | `job_addresses` table, RLS `builder_has_contract`; integration `workflow.test.ts` |
| Original quote private until redacted by admin | Implemented, tested | `media` check constraint: quote originals can never be public; only admin and the owner can view them |
| Row-level security on every table | Implemented, tested | 14 policies; integration `database.test.ts` checks cross-user reads under the `authenticated` role |
| Input validation | Implemented, tested | zod schemas in `src/lib/schemas.ts` shared by forms and API; unit `validation.test.ts` |
| CSRF | Implemented, tested, verified | `Origin` or `Sec-Fetch-Site` must be same-origin for state-changing requests; session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` on https |
| CORS | Implemented, verified | No `Access-Control-Allow-*` headers are ever sent; preflights get 405 |
| XSS | Implemented, verified | React escaping, no `dangerouslySetInnerHTML`, nonce-based CSP with `strict-dynamic`, `object-src 'none'`, `frame-ancestors 'none'` |
| Secure headers | Implemented, verified | HSTS, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, COOP, CORP (`next.config.ts`); E2E checks them |
| Rate limiting | Implemented, tested, verified | Postgres-backed so it works across serverless instances (`rate_limit_hit`). Sign-in: 5 failed attempts per account per 15 min (cleared on success) and 30 per IP; sign-up, password reset, mutations, upload intents, claims and client error reports are limited too. Auth limits fail closed if the database is down |
| Brute-force protection | Implemented, tested, verified | As above, plus scrypt password hashing in dev auth; Supabase Auth has its own limits in real use. E2E checks the sixth wrong password gets 429 |
| Generic auth errors | Implemented | Same message for unknown email and wrong password; password reset always returns the same response |
| Session expiry | Implemented, tested | Signed, expiring sessions; the browser client redirects to sign-in with a "session expired" message and keeps unsent form drafts |
| Secrets kept server-side | Implemented, tested | `import "server-only"` on all server modules; `npm run audit:secrets` scans the repo and the built browser bundles for credential-like strings and server-only variable names. Passes |
| No service-role key in the browser | Implemented, tested | Only `NEXT_PUBLIC_SUPABASE_URL` and the anon key are public; bundle scan passes |
| Production guards | Implemented, tested | `APP_ENV=production` refuses dev auth, local storage, fake payments, missing webhook/cron secrets and non-https origins at start-up. Dev storage, fake checkout and the test-only rate-limit multiplier are disabled outside dev/test |
| Signed tokens | Implemented, tested | HMAC tokens for dev storage and dev sessions are compared as canonical text. This fixed a real bug found during testing: comparing decoded bytes accepted a token whose last character had been changed |
| Audit log | Implemented, tested | `audit_log` is append-only (trigger blocks update and delete); admin decisions, offers, payments, variations, sign-ins and failures are recorded; admin can browse it |
| Webhook verification | Implemented, tested, verified | Stripe signature with a 5-minute tolerance; unsigned or tampered events get 403 |
| Cron endpoints | Implemented, verified | Require `CRON_SECRET` as a bearer token |

## 3. Database

`supabase/migrations/20261105000001_core.sql` holds the whole schema.

- **Integrity:** foreign keys everywhere; check constraints on money (pence, positive), statuses and media rules; unique constraints for one live offer per job, one open variation per job, one live deposit per contract, one row per Stripe event, and one upload per file fingerprint.
- **State machine:** allowed job transitions live in `job_status_transitions` and are enforced by a trigger (`tg_jobs_guard_transition`). The same map exists in TypeScript, and an integration test checks the two agree. Work can't start without a signed contract, a paid deposit, a confirmed pre-start check and no open variation. Every change bumps a version number.
- **Contract price is immutable:** a trigger blocks changes; price changes only through an accepted variation.
- **Two builders claiming at once:** the claim locks the job row (`FOR UPDATE`) and the unique partial index `offers_one_live_per_job` is a second guard. Integration test fires 8 concurrent claims and exactly one wins; E2E double-clicks the claim button.
- **Indexes and pagination:** 21 indexes covering the queues and lists. Lists use keyset (cursor) pagination, not offsets.
- **Statement timeout:** 10 seconds by default.

Status: implemented and tested on PostgreSQL 16 with a local stub of Supabase's `auth` and `storage` schemas (`supabase/tests/supabase_stub.sql`). **Needs external configuration:** the migration has not been applied to a real Supabase project.

## 4. Storage

- Single private bucket `job-media`. No public buckets.
- Files are stored under `jobs/<jobId>/<mediaId>/...`; names are sanitised and never used as paths.
- Viewing goes through `/api/media/<id>/view`, which checks permission and redirects to a signed URL valid for 120 seconds.
- Upload URLs are signed, single-path, size-capped and expire in 15 minutes.
- Local development and tests use an emulator (`src/app/api/dev-storage`) that implements the same signed-URL and TUS resumable protocols. It is switched off in production.

Status: implemented, tested and verified with the emulator. **Needs external configuration:** the Supabase storage provider (`src/server/storage/supabase.ts`) has not been run against a real project. The signed resumable-upload endpoint it uses (`/storage/v1/upload/resumable/sign`) should be checked against current Supabase documentation. **Supabase's free tier limits a single file to 50 MB**, which is below the 500 MB video limit set here; on the free tier, videos must be shorter or the limit lowered.

## 5. Uploads (media pipeline)

| Feature | Status |
|---|---|
| Allowed types: JPG, PNG, WEBP, PDF, MP4/M4V, MOV, WEBM | Implemented, tested |
| Checks in the browser (type, size, count) before upload | Implemented, tested |
| Magic-byte check on the server; a renamed or spoofed file is rejected | Implemented, tested, verified |
| Limits: images 20 MB, PDF 15 MB, video 500 MB, 30 files per job | Implemented, tested |
| Progress, cancel, retry, several files at once | Implemented, verified |
| Resumable upload (TUS) for large videos, survives a dropped connection and a page reload | Implemented, verified (E2E drops a chunk mid-upload) |
| Duplicate pick of the same file is ignored | Implemented, tested |
| Image re-encode with EXIF and GPS removed, orientation applied, thumbnail made | Implemented, tested (`sharp`) |
| PDF: checked, never rendered by the app | Implemented, tested |
| Video metadata removal and thumbnails | **Not implemented.** Needs an ffmpeg worker or Cloudflare Stream. Videos are stored as uploaded and shown to admin only until processed |
| HEIC photos (iPhone default) | **Not supported.** Rejected with a clear message. iPhones usually convert to JPG when uploading through a browser, but not always |
| Malware scanning | Seam implemented (`scanner.ts`, calls `MALWARE_SCANNER_URL` if set). **Needs external configuration:** no scanner is connected, so files are marked "not scanned" |
| Orphan clean-up (abandoned uploads, deleted media) | Implemented, tested (cron `cleanup-uploads`) |
| The file picker is disabled until the page is interactive, so files picked too early aren't lost | Implemented, verified |

## 6. Error handling

- One error type (`AppError`) with stable codes and plain-English messages (`src/lib/errorCodes.ts`). Database errors (unique, foreign key, check, serialisation) map to clear codes, and stack traces and SQL never reach the browser.
- Pages: `error.tsx`, `global-error.tsx`, `not-found.tsx` and `loading.tsx`; forms show field-level errors and keep what the user typed.
- Forms block double submission. The new-job form keeps a local draft, so a failed submit or a refresh doesn't lose details (verified in E2E).
- Browser errors are reported to `/api/client-errors` (rate-limited) and logged.

Status: implemented, tested, verified.

## 7. Crash recovery and resilience

| Item | Status |
|---|---|
| Timeouts on every outbound call (database, Stripe, storage, email, SMS, scanner) | Implemented, tested |
| Retry with exponential backoff and jitter, only for transient errors | Implemented, tested |
| No blind payment retries: Stripe calls use idempotency keys, and after a timeout the app asks Stripe what happened before trying again | Implemented, tested with the fake provider |
| Payment status confirmed with the provider, not only by webhook | Implemented, tested, verified (E2E drops the webhook and the payment still settles through the return-page check and the reconcile job) |
| Idempotency keys on all important writes (`Idempotency-Key` header, stored response replayed) | Implemented, tested, verified |
| Notifications sent through a transactional outbox, retried with backoff, so a failed email never rolls back the action | Implemented, tested |
| Scheduled jobs are safe to run twice or at the same time | Implemented, tested |
| Health checks: `/api/health` (process up) and `/api/health/ready` (database reachable) | Implemented, verified |
| Browser client: timeouts, retries only for safe requests, offline message | Implemented, verified |

## 8. Backups and restore

Documented in `README.md` ("Backups and restore"). **Needs external configuration:** nothing is scheduled yet. Supabase's free tier does not offer point-in-time recovery, so the plan relies on a scheduled `pg_dump` and storage export; check Supabase's current backup terms for the chosen plan. A restore has not been rehearsed.

## 9. Observability

- Structured JSON logs with a request ID on every line and in the `x-request-id` response header; emails, tokens, passwords, card data and addresses are redacted (unit-tested).
- Error reporter seam (`errorReporter.ts`) ready for Sentry. **Not connected:** no Sentry project or DSN exists, and nothing is sent anywhere.

## 10. Payments and workflow integrity

- Stripe Connect in **test mode only**. Deposits go through Checkout; the success page polls the server, which asks Stripe.
- Webhooks: verified signature, every event stored once (`payment_events` unique ID), processed in a transaction, out-of-order events handled, duplicates ignored.
- `payments` table acts as the ledger, with a unique live deposit per contract; refunds are queued, not fire-and-forget.
- If the homeowner declines a variation, the contract ends and the deposit refund is queued, as the business rules require.
- Explicit state transitions for jobs, offers, payments and variations.

Status: implemented and tested with the fake provider, which signs events in Stripe's format and is checked by Stripe's own library. **Needs external configuration:** no Stripe account, Connect onboarding or webhook endpoint is set up, and the Stripe provider has not been called with real test keys.

## 11. Test results (5 November 2026)

All runs on this machine: Node 22, PostgreSQL 16, Chromium.

| Check | Result |
|---|---|
| `npm run build` | Passes |
| `npm run typecheck` | Passes, no errors |
| `npm run lint` | Passes, no warnings |
| `npm test` (unit) | **88 passed**, 0 failed |
| `npm run test:integration` (real Postgres, RLS, concurrency) | **55 passed**, 0 failed |
| `npm run test:e2e` (Playwright, desktop and mobile) | **42 passed**, 0 failed. Recovery and security specs also passed three to four times in a row |
| Route check | Every public page renders with no console errors or failed requests, and every internal link resolves (desktop and mobile) |
| `npm run audit:secrets` | Passes: no credential-like strings in the repository or browser bundles |
| `npm audit --omit=dev` (production dependencies) | **0 vulnerabilities** |
| `npm audit` (including dev tools) | 8 moderate, all from one `minimatch` issue inside the lint tooling (`eslint-config-next`). Not shipped to users. Fix waits on an upstream release |

E2E journeys covered: a homeowner creates a job, uploads a quote, photos and a video, and submits it; admin redacts the quote, writes the scope and publishes; a partner can't see the job during crew first refusal; the crew claims it (double-click safe); the homeowner accepts and pays the deposit (with the webhook deliberately lost); the builder sees the address only after acceptance, can't start before the pre-start check, then starts. Variations (propose, accept, decline with contract end and refund) and completion are covered by integration tests, not yet by a browser test.

Not tested: real Supabase, real Stripe test mode, email and SMS delivery, load or performance testing, Safari and Firefox, screen-reader testing by a person, penetration testing.

## 12. Known limitations and open decisions

1. **Landing page versus the app.** The landing page says builders "accept the beat price or go lower" and that homeowners compare offers. The app gives the job to the first approved builder who accepts the beat price, and the homeowner sees one offer. This needs a decision.
2. **Example price.** The landing page shows £7,950 for an £8,640 quote at 8%. The pricing rule (round down to the pound) gives £7,948. One of them should change.
3. **Business numbers are placeholders:** success fee (0% until set), minimum job price (£500), deposit (10%), crew window (24 h), partner window (72 h), offer acceptance window (72 h). All are settings.
4. **Free tiers.** Vercel's free Hobby plan is for non-commercial use and runs cron jobs at most once a day; this app's jobs run every 5 to 15 minutes. Supabase's free tier limits files to 50 MB and pauses inactive projects. Running the test phase as a business may need paid plans; that is a cost decision for the owner.
5. Video processing, HEIC support, malware scanning and Sentry are seams, not working features (see above).
6. Accessibility: semantic HTML, labels, focus states, live regions and keyboard use were built in and partly checked by E2E; there has been no audit with assistive technology.
7. Legal text (terms, privacy, contract terms version `draft-2026-11`) is a draft for solicitor review.

## 13. Production readiness

**Not ready for production.** Before any real customer uses it:

1. Create the Supabase project, apply the migration, set up Auth (email templates, redirect URLs) and Storage, and run the integration checklist in `README.md` against it.
2. Create a Stripe account in test mode with Connect, set the webhook endpoint, and run the full journey with Stripe test cards.
3. Configure Resend and Twilio (sender domain, SPF/DKIM, UK sender ID), or keep the console providers for a closed test.
4. Connect a malware scanner and Sentry, or accept the risk in writing for the test phase.
5. Schedule backups and rehearse a restore.
6. Decide the open questions in section 12.
7. Solicitor review of all legal text.
8. An independent security review or penetration test before taking real payments at scale.
