import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { apiSignIn, FIX, ORIGIN, signInUI } from "./helpers";
import { readFile } from "node:fs/promises";

test("signed-out users are sent to sign in; APIs return 401", async ({ page, request }) => {
  await page.goto("/homeowner");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fhomeowner/);
  expect((await request.get("/api/jobs")).status()).toBe(401);
  expect((await request.get("/api/admin/jobs")).status()).toBe(401);
});

test("an expired session is detected and the user is asked to sign in again", async ({ page, context }) => {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", email: "x@y", iat: now - 100000, exp: now - 10, sid: "s" })).toString("base64url");
  const mac = createHmac("sha256", "e2e-session-secret-e2e-session-secret-0123456789").update(body).digest("base64url");
  await context.addCookies([{ name: "bmq_session", value: `${body}.${mac}`, url: ORIGIN }]);
  await page.goto("/homeowner");
  await expect(page).toHaveURL(/\/sign-in\?expired=1/);
  await expect(page.getByText("Your session expired")).toBeVisible();
});

test("ordinary users can't reach admin pages or APIs, and can't see other homeowners' jobs", async ({ page, browser }) => {
  await signInUI(page, "homeowner@bmq.test");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/homeowner$/);
  expect((await page.request.get("/api/admin/jobs")).status()).toBe(403);
  expect((await page.request.get("/api/admin/audit")).status()).toBe(403);
  // Self-contained: the homeowner makes their own private job for the others to probe.
  const created = await page.request.post("/api/jobs", {
    headers: { Origin: ORIGIN },
    data: { submissionKey: `authz-${Date.now()}`, draft: { trade: "bathroom-refit", title: "E2E bathroom refit", description: "", address: { line1: "12 Hidden Road", town: "London", postcode: "SE15 1AA" }, quote: { pricePounds: "8640" } } },
  });
  expect(created.status()).toBe(201);
  const someJob = ((await created.json()) as { id: string }).id;

  const other = await browser.newContext();
  const p2 = await other.newPage();
  await signInUI(p2, "homeowner2@bmq.test");
  // Pages stream behind a loading state, so Next.js may send the not-found page with a
  // 200 status; what matters is that no data is rendered. The API returns a real 404.
  await p2.goto(`/homeowner/jobs/${someJob}`);
  await expect(p2.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(p2.getByText("E2E bathroom refit")).toHaveCount(0);
  await expect(p2.getByText("12 Hidden Road")).toHaveCount(0);
  expect((await p2.request.get(`/api/jobs/${someJob}`)).status()).toBe(404);
  const builder = await browser.newContext();
  const p3 = await builder.newPage();
  await signInUI(p3, "crew@bmq.test");
  expect((await p3.request.get(`/api/jobs/${someJob}`)).status()).toBe(403);
  expect((await p3.request.post(`/api/admin/builders/${someJob}/decision`, { headers: { Origin: ORIGIN, "Idempotency-Key": "abcdefgh1234" }, data: { decision: "approve", kind: "crew" } })).status()).toBe(403);
});

test("a pending builder can't take jobs", async ({ request }) => {
  await apiSignIn(request, "pending@bmq.test");
  expect((await request.get("/api/builder/jobs")).status()).toBe(403);
});

test("cross-site requests are refused (CSRF) and CORS preflights get no access", async ({ request }) => {
  await apiSignIn(request, "homeowner@bmq.test");
  const r = await request.post("/api/jobs", { headers: { Origin: "https://evil.example" }, data: {} });
  expect(r.status()).toBe(403);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("CSRF_FAILED");
  const pre = await request.fetch("/api/jobs", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  expect(pre.status()).toBe(405);
  expect(pre.headers()["access-control-allow-origin"]).toBeUndefined();
});

test("malformed and invalid requests are rejected with safe messages", async ({ request }) => {
  await apiSignIn(request, "homeowner@bmq.test");
  const bad = await request.post("/api/jobs", { headers: { Origin: ORIGIN, "Content-Type": "application/json" }, data: "{not json" });
  expect(bad.status()).toBe(422);
  const wrongType = await request.post("/api/jobs", { headers: { Origin: ORIGIN, "Content-Type": "text/plain" }, data: "x" });
  expect(wrongType.status()).toBe(422);
  const invalid = await request.post("/api/jobs", { headers: { Origin: ORIGIN }, data: { submissionKey: "abcdefgh", draft: { trade: "x" } } });
  const body = (await invalid.json()) as { error: { code: string; message: string; fields: Record<string, string> } };
  expect(invalid.status()).toBe(422);
  expect(body.error.code).toBe("VALIDATION_FAILED");
  expect(JSON.stringify(body)).not.toMatch(/stack|postgres|sql|at .*\.ts/i);
  expect((await request.get("/api/jobs/not-a-uuid")).status()).toBe(404);
});

test("invalid, spoofed and oversized uploads are refused", async ({ request }) => {
  await apiSignIn(request, "homeowner@bmq.test");
  const create = await request.post("/api/jobs", { headers: { Origin: ORIGIN }, data: { submissionKey: `uploads-${Date.now()}`, draft: { trade: "bathroom-refit", title: "Upload checks", description: "", address: { line1: "1 A St", town: "London", postcode: "SE15 1AA" }, quote: { pricePounds: "5000" } } } });
  const { id } = (await create.json()) as { id: string };
  const intents = await request.post(`/api/jobs/${id}/media/intents`, {
    headers: { Origin: ORIGIN },
    data: { kind: "photo", files: [
      { name: "a.svg", size: 100, type: "image/svg+xml", fingerprint: "svg-fingerprint" },
      { name: "big.jpg", size: 500 * 1024 * 1024, type: "image/jpeg", fingerprint: "big-fingerprint" },
      { name: "spoof.jpg", size: 38, type: "image/jpeg", fingerprint: "spoof-fingerprint" },
    ] },
  });
  const { results } = (await intents.json()) as { results: Array<{ ok: boolean; code?: string; mediaId?: string; target?: { url: string } }> };
  expect(results[0]).toMatchObject({ ok: false, code: "UPLOAD_INVALID_TYPE" });
  expect(results[1]).toMatchObject({ ok: false, code: "UPLOAD_TOO_LARGE" });
  // Upload HTML bytes to the signed URL while claiming JPEG.
  const spoof = results[2]!;
  const bytes = await readFile(FIX("not-really.jpg"));
  expect((await request.put(spoof.target!.url, { headers: { "content-type": "image/jpeg" }, data: bytes })).status()).toBe(200);
  const done = await request.post(`/api/media/${spoof.mediaId}/complete`, { headers: { Origin: ORIGIN }, data: {} });
  expect(done.status()).toBe(422);
  expect(((await done.json()) as { error: { code: string } }).error.code).toBe("UPLOAD_CONTENT_MISMATCH");
  // Upload URLs are scoped to the reserved size and path.
  const tamper = spoof.target!.url.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  expect((await request.put(tamper, { headers: { "content-type": "image/jpeg" }, data: bytes })).status()).toBe(403);
});

test("repeated wrong passwords are rate limited", async ({ request }) => {
  const email = `brute-${Date.now()}@bmq.test`;
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await request.post("/api/auth/sign-in", { headers: { Origin: ORIGIN }, data: { email, password: "wrong-password" } })).status());
  expect(codes.slice(0, 5).every((c) => c === 422)).toBe(true);
  expect(codes[5]).toBe(429);
});

test("security headers are set", async ({ request }) => {
  const r = await request.get("/");
  const h = r.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["strict-transport-security"]).toContain("max-age=");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["x-powered-by"]).toBeUndefined();
  expect(h["x-request-id"]).toMatch(/[0-9a-f-]{36}/);
});

test("the payment webhook rejects unsigned events", async ({ request }) => {
  const r = await request.post("/api/webhooks/stripe", { data: { id: "evt_forged", type: "checkout.session.completed" } });
  expect(r.status()).toBe(403);
});

test("cron endpoints require the secret", async ({ request }) => {
  expect((await request.get("/api/cron/advance-windows")).status()).toBe(403);
  expect((await request.get("/api/cron/advance-windows", { headers: { Authorization: "Bearer e2e-cron-secret-e2e-cron-secret-0123456789" } })).status()).toBe(200);
});
