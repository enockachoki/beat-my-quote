import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import sharp from "sharp";
import { E2E_ENV } from "../../playwright.config";

export const FIXTURES = path.resolve("tests/e2e/fixtures");

/** Disposable E2E database + generated media fixtures. Never touches real data. */
export default async function globalSetup() {
  const url = new URL(E2E_ENV.DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || !url.pathname.startsWith("/bmq_e2e")) throw new Error("E2E must use a local bmq_e2e database");
  const admin = postgres({ host: url.hostname, port: Number(url.port || 5432), user: url.username, password: url.password, database: "postgres", max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${url.pathname.slice(1)} with (force)`);
  await admin.unsafe(`create database ${url.pathname.slice(1)}`);
  await admin.end();
  const env = { ...process.env, DATABASE_URL: E2E_ENV.DATABASE_URL };
  execFileSync("node", ["scripts/migrate.mjs", "--local-stub", "--dev-auth"], { env, stdio: "inherit" });
  execFileSync("node", ["scripts/seed-dev.mjs"], { env, stdio: "inherit" });
  await rm(path.resolve(".dev-storage/e2e"), { recursive: true, force: true });

  await mkdir(FIXTURES, { recursive: true });
  for (const [i, colour] of ["#d9822b", "#2b7bd9", "#3ca55c"].entries()) {
    const img = await sharp({ create: { width: 800, height: 600, channels: 3, background: colour } })
      .jpeg()
      .withExif({ IFD0: { Make: "E2ECam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 28/1 0/1" } })
      .toBuffer();
    await writeFile(path.join(FIXTURES, `photo${i + 1}.jpg`), img);
  }
  await writeFile(path.join(FIXTURES, "quote.pdf"), "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  await writeFile(path.join(FIXTURES, "redacted.pdf"), "%PDF-1.4\n% redacted copy\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  await writeFile(path.join(FIXTURES, "not-really.jpg"), "<html><script>alert(1)</script></html>");
  // 8 MB "MP4" (valid ftyp header) so it goes through resumable TUS chunks.
  const video = Buffer.alloc(8 * 1024 * 1024);
  Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypisom")]).copy(video, 0);
  await writeFile(path.join(FIXTURES, "walkthrough.mp4"), video);
}
