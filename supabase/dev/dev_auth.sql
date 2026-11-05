-- DEVELOPMENT/E2E ONLY: credentials for the local dev auth provider.
-- Production uses Supabase Auth; this table must never exist in production.
create table if not exists public.dev_credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  password_hash text not null,
  reset_token_hash text,
  reset_expires_at timestamptz
);
alter table public.dev_credentials enable row level security;
revoke all on public.dev_credentials from anon, authenticated;
