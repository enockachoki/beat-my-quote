import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

/**
 * Creates a fresh, disposable test database (never production) and applies
 * the real migrations plus the local Supabase stub and dev-auth table.
 */
export default async function setup() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bmq_it");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Integration tests only run against a local database");
  const dbName = url.pathname.slice(1);
  if (!/^bmq_(it|test)\w*$/.test(dbName)) throw new Error("Test database name must start with bmq_it or bmq_test");
  const admin = postgres({ host: url.hostname, port: Number(url.port || 5432), user: url.username, password: url.password, database: "postgres", max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.unsafe(`create database ${dbName}`);
  await admin.end();
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const root = path.resolve(import.meta.dirname, "..", "..", "supabase");
  await sql.unsafe(await readFile(path.join(root, "tests", "supabase_stub.sql"), "utf8"));
  for (const f of (await readdir(path.join(root, "migrations"))).sort()) await sql.unsafe(await readFile(path.join(root, "migrations", f), "utf8"));
  await sql.unsafe(await readFile(path.join(root, "dev", "dev_auth.sql"), "utf8"));
  await sql.end();
}
