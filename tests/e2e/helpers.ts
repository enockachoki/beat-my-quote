import { expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import path from "node:path";

export const ORIGIN = "http://localhost:3100";
export const PASSWORD = "TestPassword123!";
export const FIX = (f: string) => path.resolve("tests/e2e/fixtures", f);

export async function signInUI(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"));
}

export async function newSignedInPage(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signInUI(page, email);
  return page;
}

export async function apiSignIn(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/sign-in", { headers: { Origin: ORIGIN }, data: { email, password: PASSWORD } });
  expect(r.status()).toBe(200);
}

/** Collects console errors and failed requests so a test can assert the page is clean. */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

/** Picks files once the uploader has hydrated (the picker is disabled until then). */
export async function pickFiles(page: Page, kind: string, files: string | string[]) {
  const input = page.getByTestId(`file-${kind}`);
  await expect(input).toBeEnabled();
  await input.setInputFiles(files);
}
