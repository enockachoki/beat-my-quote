#!/usr/bin/env node
// DEVELOPMENT ONLY: creates test accounts for the dev auth provider.
// Refuses to run against anything that is not a local database.
import { randomBytes, scryptSync } from "node:crypto";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) {
  console.error("seed-dev only runs against a local database");
  process.exit(1);
}
const PASSWORD = process.env.SEED_PASSWORD ?? "TestPassword123!";
const hash = (pw) => {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pw, salt, 64).toString("base64")}`;
};
const people = [
  { email: "admin@bmq.test", role: "admin", name: "Test Admin" },
  { email: "homeowner@bmq.test", role: "homeowner", name: "Hana Homeowner" },
  { email: "homeowner2@bmq.test", role: "homeowner", name: "Omar Other" },
  { email: "crew@bmq.test", role: "builder", name: "Cara Crew", builder: { kind: "crew", company: "BMQ Building Ltd (crew)" } },
  { email: "partner@bmq.test", role: "builder", name: "Pat Partner", builder: { kind: "partner", company: "Partner Bathrooms Ltd" } },
  { email: "pending@bmq.test", role: "builder", name: "Penny Pending", builder: { kind: null, company: "Pending Builds Ltd" } },
];
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  for (const p of people) {
    const [u] = await sql`insert into auth.users (email) values (${p.email}) on conflict (email) do update set email = excluded.email returning id`;
    await sql`insert into public.dev_credentials (user_id, email, password_hash) values (${u.id}, ${p.email}, ${hash(PASSWORD)})
      on conflict (user_id) do update set password_hash = excluded.password_hash`;
    await sql`insert into public.profiles (id, role, full_name, phone) values (${u.id}, ${p.role}, ${p.name}, '07700 900000')
      on conflict (id) do update set role = excluded.role`;
    if (p.builder) {
      await sql`insert into public.builders (id, kind, status, company_name, trades, service_districts)
        values (${u.id}, ${p.builder.kind}, ${p.builder.kind ? "approved" : "pending"}, ${p.builder.company}, ${["bathroom-refit", "kitchen-fitting"]}, ${["SE15", "SE22", "SE5"]})
        on conflict (id) do nothing`;
    }
  }
  console.log(`seeded ${people.length} dev accounts`);
} finally {
  await sql.end();
}
