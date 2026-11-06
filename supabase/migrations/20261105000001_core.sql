-- Beat My Quote: core schema, constraints, state-machine guards and RLS.
-- Money is stored as integer pence, inclusive of VAT, unless a column says otherwise.
-- All mutations are performed by the server (service connection) after explicit
-- authorisation checks. The browser-facing roles (anon, authenticated) are granted
-- SELECT only, and only through Row Level Security policies.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('homeowner', 'builder', 'admin');
create type public.builder_kind as enum ('crew', 'partner');
create type public.builder_status as enum ('pending', 'approved', 'rejected', 'suspended');
create type public.job_status as enum (
  'draft', 'submitted', 'in_review', 'rejected', 'crew_window', 'partner_window',
  'offer_pending', 'awaiting_deposit', 'deposit_paid', 'in_progress', 'completed',
  'cancelled', 'unmatched'
);
create type public.offer_status as enum ('pending', 'accepted', 'declined', 'expired', 'withdrawn');
create type public.contract_status as enum ('active', 'terminated', 'completed');
create type public.media_kind as enum ('photo', 'video', 'quote_document', 'quote_redacted');
create type public.media_status as enum ('pending_upload', 'uploaded', 'processing', 'ready', 'quarantined', 'rejected', 'deleted');
create type public.scan_status as enum ('not_scanned', 'clean', 'infected', 'scanner_unavailable');
create type public.variation_reason as enum ('not_reasonably_visible', 'homeowner_requested');
create type public.variation_status as enum ('proposed', 'approved', 'declined', 'withdrawn');
create type public.payment_kind as enum ('deposit', 'stage', 'final', 'refund');
create type public.payment_status as enum ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'unknown', 'refunded');
create type public.notification_status as enum ('pending', 'sent', 'failed', 'dead');

-- ---------------------------------------------------------------------------
-- Utility triggers
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null default 'homeowner',
  full_name text not null check (char_length(full_name) between 1 and 120),
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{7,20}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles
  for each row execute function public.tg_set_updated_at();

create table public.builders (
  id uuid primary key references public.profiles (id) on delete cascade,
  kind public.builder_kind,               -- assigned by admin on approval
  status public.builder_status not null default 'pending',
  company_name text not null check (char_length(company_name) between 2 and 160),
  companies_house_number text check (companies_house_number is null or companies_house_number ~ '^[A-Z0-9]{8}$'),
  trades text[] not null check (cardinality(trades) between 1 and 10),
  service_districts text[] not null check (cardinality(service_districts) between 1 and 50),
  insurance_expires_on date,
  stripe_account_id text unique,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint approved_builder_has_kind check (status <> 'approved' or kind is not null)
);
create trigger builders_updated before update on public.builders
  for each row execute function public.tg_set_updated_at();
create index builders_status_idx on public.builders (status);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  homeowner_id uuid not null references public.profiles (id) on delete restrict,
  status public.job_status not null default 'draft',
  trade text not null check (char_length(trade) between 2 and 60),
  title text not null check (char_length(title) between 3 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  postcode_district text not null check (postcode_district ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?$'),
  standard_scope text check (standard_scope is null or char_length(standard_scope) <= 8000),
  beat_percent numeric(4,2) check (beat_percent is null or beat_percent between 5 and 10),
  beat_price_pence integer check (beat_price_pence is null or beat_price_pence > 0),
  current_window public.builder_kind,
  window_ends_at timestamptz,
  submission_key text,
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  rejection_reason text check (rejection_reason is null or char_length(rejection_reason) <= 1000),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_submission_key_unique unique (homeowner_id, submission_key),
  constraint window_jobs_have_price check (
    status not in ('crew_window', 'partner_window', 'offer_pending', 'awaiting_deposit', 'deposit_paid', 'in_progress', 'completed')
    or (beat_price_pence is not null and standard_scope is not null)
  )
);
create trigger jobs_updated before update on public.jobs
  for each row execute function public.tg_set_updated_at();
create index jobs_homeowner_idx on public.jobs (homeowner_id, created_at desc);
create index jobs_status_idx on public.jobs (status, created_at desc);
create index jobs_window_idx on public.jobs (status, window_ends_at) where status in ('crew_window', 'partner_window');
create index jobs_trade_district_idx on public.jobs (trade, postcode_district) where status in ('crew_window', 'partner_window');

-- Private details are split into separate tables so that column-level secrecy
-- does not depend on every query remembering to omit columns.
create table public.job_addresses (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  line1 text not null check (char_length(line1) between 1 and 200),
  line2 text check (line2 is null or char_length(line2) <= 200),
  town text not null check (char_length(town) between 1 and 100),
  postcode text not null check (postcode ~ '^[A-Z]{1,2}[0-9][0-9A-Z]? ?[0-9][A-Z]{2}$')
);

create table public.job_quotes (
  job_id uuid primary key references public.jobs (id) on delete cascade,
  quote_price_pence integer not null check (quote_price_pence between 10000 and 100000000),
  rival_company_name text check (rival_company_name is null or char_length(rival_company_name) <= 160),
  quote_date date
);

-- The single source of truth for allowed job transitions. The TypeScript domain
-- model (src/server/domain/jobStateMachine.ts) mirrors this; an integration test
-- checks they agree.
create table public.job_status_transitions (
  from_status public.job_status not null,
  to_status public.job_status not null,
  primary key (from_status, to_status)
);
insert into public.job_status_transitions (from_status, to_status) values
  ('draft', 'submitted'), ('draft', 'cancelled'),
  ('submitted', 'in_review'), ('submitted', 'cancelled'),
  ('in_review', 'crew_window'), ('in_review', 'rejected'), ('in_review', 'cancelled'),
  ('crew_window', 'partner_window'), ('crew_window', 'offer_pending'), ('crew_window', 'cancelled'),
  ('partner_window', 'offer_pending'), ('partner_window', 'unmatched'), ('partner_window', 'cancelled'),
  ('offer_pending', 'awaiting_deposit'), ('offer_pending', 'crew_window'), ('offer_pending', 'partner_window'),
  ('offer_pending', 'unmatched'), ('offer_pending', 'cancelled'),
  ('awaiting_deposit', 'deposit_paid'), ('awaiting_deposit', 'cancelled'),
  ('deposit_paid', 'in_progress'), ('deposit_paid', 'cancelled'),
  ('in_progress', 'completed');

-- ---------------------------------------------------------------------------
-- Offers, contracts, pre-start checks, variations
-- ---------------------------------------------------------------------------
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  builder_id uuid not null references public.builders (id) on delete restrict,
  via_window public.builder_kind not null,
  price_pence integer not null check (price_pence > 0),
  status public.offer_status not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
-- At most one live offer per job: the database itself stops two builders
-- winning the same job, even if application-level locking were bypassed.
create unique index offers_one_live_per_job on public.offers (job_id) where status in ('pending', 'accepted');
create index offers_builder_idx on public.offers (builder_id, created_at desc);
create index offers_pending_expiry_idx on public.offers (expires_at) where status = 'pending';

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.jobs (id) on delete restrict,
  offer_id uuid not null unique references public.offers (id) on delete restrict,
  homeowner_id uuid not null references public.profiles (id),
  builder_id uuid not null references public.builders (id),
  price_pence integer not null check (price_pence > 0),
  deposit_pence integer not null check (deposit_pence > 0),
  terms_version text not null,
  status public.contract_status not null default 'active',
  homeowner_accepted_at timestamptz not null default now(),
  terminated_reason text,
  created_at timestamptz not null default now(),
  constraint deposit_not_more_than_price check (deposit_pence <= price_pence)
);

-- Contract price can never be edited. Price changes only via approved variations.
create or replace function public.tg_contracts_immutable_price() returns trigger
language plpgsql as $$
begin
  if new.price_pence <> old.price_pence or new.deposit_pence <> old.deposit_pence
     or new.job_id <> old.job_id or new.builder_id <> old.builder_id or new.homeowner_id <> old.homeowner_id then
    raise exception 'CONTRACT_IMMUTABLE' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger contracts_immutable before update on public.contracts
  for each row execute function public.tg_contracts_immutable_price();

create table public.prestart_checks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  builder_id uuid not null references public.builders (id),
  outcome text not null check (outcome in ('confirmed', 'variation_required')),
  notes text check (notes is null or char_length(notes) <= 4000),
  checked_at timestamptz not null default now()
);
create index prestart_checks_job_idx on public.prestart_checks (job_id, checked_at desc);

create table public.variations (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  contract_id uuid not null references public.contracts (id),
  proposed_by uuid not null references public.profiles (id),
  reason public.variation_reason not null,
  description text not null check (char_length(description) between 10 and 4000),
  amount_pence integer not null check (amount_pence <> 0 and amount_pence between -100000000 and 100000000),
  status public.variation_status not null default 'proposed',
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index variations_one_open_per_job on public.variations (job_id) where status = 'proposed';
create index variations_job_idx on public.variations (job_id, created_at desc);

-- Agreed price = contract price + approved variations. There is deliberately no
-- mutable "agreed price" column to tamper with.
create or replace function public.job_agreed_price_pence(p_job_id uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select c.price_pence + coalesce((
    select sum(v.amount_pence)::integer from public.variations v
    where v.contract_id = c.id and v.status = 'approved'), 0)
  from public.contracts c where c.job_id = p_job_id
$$;

-- ---------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------
create table public.media (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete cascade,
  uploaded_by uuid not null references public.profiles (id),
  kind public.media_kind not null,
  status public.media_status not null default 'pending_upload',
  scan_status public.scan_status not null default 'not_scanned',
  client_fingerprint text not null check (char_length(client_fingerprint) between 8 and 300),
  original_filename text not null check (char_length(original_filename) between 1 and 200),
  declared_mime text not null,
  detected_mime text,
  size_bytes bigint not null check (size_bytes > 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  processed_path text,
  thumbnail_path text,
  metadata_stripped boolean not null default false,
  visible_to_builders boolean not null default false,
  error_code text,
  attempts integer not null default 0,
  upload_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Original quotations are never shown to builders; only an admin-made redacted copy can be.
  constraint quote_originals_never_public check (not (kind = 'quote_document' and visible_to_builders)),
  constraint only_ready_media_public check (not visible_to_builders or (status = 'ready' and scan_status <> 'infected'))
);
create trigger media_updated before update on public.media
  for each row execute function public.tg_set_updated_at();
create unique index media_no_duplicate_uploads on public.media (job_id, client_fingerprint)
  where status not in ('rejected', 'deleted');
create index media_job_idx on public.media (job_id, created_at);
create index media_pipeline_idx on public.media (status, updated_at) where status in ('pending_upload', 'uploaded', 'processing');

-- ---------------------------------------------------------------------------
-- Payments ledger
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  kind public.payment_kind not null,
  amount_pence integer not null check (amount_pence > 0),
  currency text not null default 'gbp' check (currency = 'gbp'),
  status public.payment_status not null default 'created',
  provider text not null default 'stripe',
  provider_session_id text unique,
  provider_payment_intent_id text unique,
  idempotency_key text not null unique,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger payments_updated before update on public.payments
  for each row execute function public.tg_set_updated_at();
create index payments_job_idx on public.payments (job_id, created_at);
create index payments_unsettled_idx on public.payments (status, updated_at) where status in ('created', 'pending', 'unknown');
create unique index payments_one_live_deposit on public.payments (contract_id)
  where kind = 'deposit' and status in ('created', 'pending', 'unknown', 'succeeded');

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider_event_id text not null unique,
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text
);

-- ---------------------------------------------------------------------------
-- Guard: work cannot start without contract, paid deposit and pre-start check.
-- ---------------------------------------------------------------------------
create or replace function public.tg_jobs_guard_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.job_status_transitions t
                   where t.from_status = old.status and t.to_status = new.status) then
      raise exception 'INVALID_JOB_TRANSITION %->%', old.status, new.status using errcode = 'P0001';
    end if;
    if new.status = 'in_progress' then
      if not exists (select 1 from public.contracts c where c.job_id = new.id and c.status = 'active') then
        raise exception 'START_REQUIRES_CONTRACT' using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.payments p where p.job_id = new.id and p.kind = 'deposit' and p.status = 'succeeded') then
        raise exception 'START_REQUIRES_DEPOSIT' using errcode = 'P0001';
      end if;
      if not exists (select 1 from public.prestart_checks pc where pc.job_id = new.id and pc.outcome = 'confirmed') then
        raise exception 'START_REQUIRES_PRESTART_CHECK' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.variations v where v.job_id = new.id and v.status = 'proposed') then
        raise exception 'START_BLOCKED_BY_OPEN_VARIATION' using errcode = 'P0001';
      end if;
    end if;
    new.version := old.version + 1;
  end if;
  return new;
end $$;
create trigger jobs_guard_transition before update on public.jobs
  for each row execute function public.tg_jobs_guard_transition();

-- ---------------------------------------------------------------------------
-- Operational tables
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id text,
  correlation_id text,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_entity_idx on public.audit_log (entity_type, entity_id, at desc);
create index audit_log_at_idx on public.audit_log (at desc);

-- Append-only: block updates and deletes for everyone, including the table owner.
create or replace function public.tg_audit_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'AUDIT_LOG_APPEND_ONLY' using errcode = 'P0001';
end $$;
create trigger audit_log_no_update before update or delete on public.audit_log
  for each row execute function public.tg_audit_append_only();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function public.tg_audit_append_only();

create table public.idempotency_keys (
  user_id uuid not null,
  key text not null check (char_length(key) between 8 and 100),
  route text not null,
  request_hash text not null,
  state text not null default 'in_progress' check (state in ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index idempotency_keys_created_idx on public.idempotency_keys (created_at);

create table public.rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits integer not null
);

-- Fixed-window rate limiter; a single atomic statement so concurrent requests
-- across serverless instances cannot race past the limit.
create or replace function public.rate_limit_hit(p_bucket text, p_max integer, p_window_seconds integer)
returns table (allowed boolean, remaining integer, reset_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_hits integer;
  v_start timestamptz;
begin
  insert into public.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning r.hits, r.window_start into v_hits, v_start;
  return query select v_hits <= p_max, greatest(p_max - v_hits, 0), v_start + make_interval(secs => p_window_seconds);
end $$;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel text not null check (channel in ('email', 'sms')),
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  status public.notification_status not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_due_idx on public.notifications (next_attempt_at) where status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- Authorisation helpers for RLS (security definer, fixed search_path)
-- ---------------------------------------------------------------------------
create or replace function public.current_app_role() returns public.app_role
language sql stable security definer set search_path = '' as $$
  select p.role from public.profiles p where p.id = auth.uid()
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.role = 'admin' from public.profiles p where p.id = auth.uid()), false)
$$;

-- Can the current user (as an approved builder) see this job in an open window?
create or replace function public.builder_can_see_job(p_job_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.jobs j
    join public.builders b on b.id = auth.uid()
    where j.id = p_job_id
      and b.status = 'approved'
      and (
        (j.status = 'crew_window' and b.kind = 'crew')
        or (j.status = 'partner_window' and b.kind in ('crew', 'partner'))
      )
      and j.trade = any (b.trades)
      and j.postcode_district = any (b.service_districts)
  ) or exists (
    select 1 from public.offers o where o.job_id = p_job_id and o.builder_id = auth.uid()
  )
$$;

create or replace function public.builder_has_contract(p_job_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.contracts c
                 where c.job_id = p_job_id and c.builder_id = auth.uid() and c.status in ('active', 'completed'))
$$;

create or replace function public.owns_job(p_job_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.jobs j where j.id = p_job_id and j.homeowner_id = auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.builders enable row level security;
alter table public.jobs enable row level security;
alter table public.job_addresses enable row level security;
alter table public.job_quotes enable row level security;
alter table public.job_status_transitions enable row level security;
alter table public.offers enable row level security;
alter table public.contracts enable row level security;
alter table public.prestart_checks enable row level security;
alter table public.variations enable row level security;
alter table public.media enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.audit_log enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.rate_limits enable row level security;
alter table public.notifications enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy builders_select on public.builders for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy jobs_select on public.jobs for select to authenticated
  using (homeowner_id = auth.uid() or public.is_admin() or public.builder_can_see_job(id));

-- Address is revealed to a builder only once the homeowner has accepted their offer.
create policy job_addresses_select on public.job_addresses for select to authenticated
  using (public.owns_job(job_id) or public.is_admin() or public.builder_has_contract(job_id));

-- The rival quote is never visible to builders.
create policy job_quotes_select on public.job_quotes for select to authenticated
  using (public.owns_job(job_id) or public.is_admin());

create policy transitions_select on public.job_status_transitions for select to authenticated using (true);

create policy offers_select on public.offers for select to authenticated
  using (builder_id = auth.uid() or public.owns_job(job_id) or public.is_admin());

create policy contracts_select on public.contracts for select to authenticated
  using (builder_id = auth.uid() or homeowner_id = auth.uid() or public.is_admin());

create policy prestart_select on public.prestart_checks for select to authenticated
  using (builder_id = auth.uid() or public.owns_job(job_id) or public.is_admin());

create policy variations_select on public.variations for select to authenticated
  using (public.owns_job(job_id) or public.builder_has_contract(job_id) or public.is_admin());

create policy media_select on public.media for select to authenticated
  using (
    public.owns_job(job_id)
    or public.is_admin()
    or (visible_to_builders and status = 'ready' and kind <> 'quote_document' and public.builder_can_see_job(job_id))
  );

create policy payments_select on public.payments for select to authenticated
  using (public.owns_job(job_id) or public.is_admin()
         or exists (select 1 from public.contracts c where c.id = contract_id and c.builder_id = auth.uid()));

create policy audit_admin_select on public.audit_log for select to authenticated using (public.is_admin());
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
-- payment_events, idempotency_keys, rate_limits: no policies -> no access for browser roles.

-- ---------------------------------------------------------------------------
-- Grants: browser roles read through RLS only; no direct writes at all.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;
grant usage on schema public to authenticated;
grant select on public.profiles, public.builders, public.jobs, public.job_addresses, public.job_quotes,
  public.job_status_transitions, public.offers, public.contracts, public.prestart_checks, public.variations,
  public.media, public.payments, public.audit_log, public.notifications to authenticated;
grant execute on function public.current_app_role(), public.is_admin(), public.builder_can_see_job(uuid),
  public.builder_has_contract(uuid), public.owns_job(uuid), public.job_agreed_price_pence(uuid) to authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Storage: one private bucket. No storage.objects policies are created, so
-- browser roles cannot list, read or write objects; the server issues
-- short-lived signed URLs after its own authorisation checks.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('job-media', 'job-media', false, 524288000,
        array['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime', 'video/webm'])
on conflict (id) do update set public = false;
