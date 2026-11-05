#!/usr/bin/env node
// Applies supabase/migrations/*.sql in order, once each, inside transactions.
// Usage: DATABASE_URL=... node scripts/migrate.mjs [--local-stub] [--dev-auth]
//   --local-stub  plain PostgreSQL only: create the minimal Supabase auth/storage stubs first
//   --dev-auth    development/E2E only: create the dev credentials table
// Against Supabase, prefer `supabase db push`; this script is for local/CI databases.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const args = new Set(process.argv.slice(2));
if (/supabase\.(co|com)/.test(url) && (args.has("--local-stub") || args.has("--dev-auth"))) {
  console.error("Refusing to apply local stubs or dev auth to a Supabase database");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
const root = path.resolve(import.meta.dirname, "..", "supabase");
try {
  if (args.has("--local-stub")) await sql.unsafe(await readFile(path.join(root, "tests", "supabase_stub.sql"), "utf8"));
  await sql`create table if not exists public._migrations (name text primary key, applied_at timestamptz not null default now())`;
  const files = (await readdir(path.join(root, "migrations"))).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const [done] = await sql`select 1 from public._migrations where name = ${f}`;
    if (done) continue;
    const body = await readFile(path.join(root, "migrations", f), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into public._migrations (name) values (${f})`;
    });
    console.log(`applied ${f}`);
  }
  if (args.has("--dev-auth")) await sql.unsafe(await readFile(path.join(root, "dev", "dev_auth.sql"), "utf8"));
  await sql`revoke all on public._migrations from anon, authenticated`;
  console.log("migrations up to date");
} finally {
  await sql.end();
}
