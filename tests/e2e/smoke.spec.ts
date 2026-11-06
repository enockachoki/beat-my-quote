import { expect, test } from "@playwright/test";
import { watchConsole } from "./helpers";

/** Public routes render without console errors or broken links, on desktop and mobile. */
const ROUTES = ["/", "/sign-in", "/sign-up", "/sign-up?type=builder", "/forgot-password", "/reset-password", "/terms", "/privacy", "/does-not-exist"];

for (const route of ROUTES) {
  test(`renders ${route} cleanly`, async ({ page }) => {
    const errors = watchConsole(page);
    const res = await page.goto(route);
    expect(res?.status()).toBe(route === "/does-not-exist" ? 404 : 200);
    await expect(page.locator("main h1").first()).toBeVisible();
    // No horizontal scrolling on phones.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors.filter((e) => !e.includes("404"))).toEqual([]);
  });
}

test("internal links on public pages resolve", async ({ page, request }) => {
  const seen = new Set<string>();
  for (const route of ["/", "/sign-in", "/sign-up"]) {
    await page.goto(route);
    for (const href of await page.locator("a[href^='/']").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))) seen.add(href.split("#")[0]!);
  }
  for (const href of seen) {
    if (!href) continue;
    const r = await request.get(href, { maxRedirects: 0 });
    expect([200, 307, 308], `${href} -> ${r.status()}`).toContain(r.status());
  }
});

test("health endpoints respond", async ({ request }) => {
  expect((await request.get("/api/health")).status()).toBe(200);
  const ready = await request.get("/api/health/ready");
  expect(ready.status()).toBe(200);
  expect(((await ready.json()) as { checks: { database: { ok: boolean } } }).checks.database.ok).toBe(true);
});
