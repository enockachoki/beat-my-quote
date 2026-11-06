import { expect, test } from "@playwright/test";
import { apiSignIn, FIX, ORIGIN, pickFiles, signInUI } from "./helpers";

test("failed submission keeps the user's details and retries without creating duplicates", async ({ page }) => {
  const title = `Recovery test kitchen ${Date.now()}`;
  await signInUI(page, "homeowner2@bmq.test");
  await page.goto("/homeowner/jobs/new");
  await page.getByLabel("Type of job").selectOption("kitchen-fitting");
  await page.getByLabel("Short title").fill(title);
  await page.getByLabel("Quote total, including VAT (£)").fill("12000");
  await page.getByLabel("Address line 1").fill("5 Recovery Lane");
  await page.getByLabel("Town or city").fill("London");
  await page.getByLabel("Postcode").fill("SE22 8AA");

  // The connection drops on the first attempts.
  let failures = 0;
  await page.route("**/api/jobs", async (route) => {
    if (route.request().method() === "POST" && failures < 3) {
      failures++;
      return route.abort("internetdisconnected");
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Save and add photos" }).click();
  await expect(page.getByRole("alert").first()).toContainText(/offline|unavailable|kept/i);
  await expect(page.getByLabel("Short title")).toHaveValue(title);

  // The browser is refreshed: entries are restored from local storage.
  await page.unroute("**/api/jobs");
  await page.reload();
  await expect(page.getByText("restored the details")).toBeVisible();
  await expect(page.getByLabel("Short title")).toHaveValue(title);
  await page.getByRole("button", { name: "Save and add photos" }).click();
  await page.waitForURL(/\/homeowner\/jobs\/[0-9a-f-]{36}$/);

  const list = await page.request.get("/api/jobs");
  const titles = ((await list.json()) as { items: { title: string }[] }).items.filter((j) => j.title === title);
  expect(titles.length).toBe(1);
});

test("an interrupted resumable video upload can be retried and finishes", async ({ page }) => {
  await signInUI(page, "homeowner2@bmq.test");
  const create = await page.request.post("/api/jobs", {
    headers: { Origin: ORIGIN },
    data: { submissionKey: `upload-recovery-${Date.now()}`, draft: { trade: "bathroom-refit", title: "Upload recovery", description: "", address: { line1: "1 A St", town: "London", postcode: "SE15 1AA" }, quote: { pricePounds: "5000" } } },
  });
  const { id } = (await create.json()) as { id: string };
  await page.goto(`/homeowner/jobs/${id}`);

  // Drop the connection on the second chunk.
  let patches = 0;
  await page.route("**/api/dev-storage/tus/**", async (route) => {
    if (route.request().method() === "PATCH" && ++patches === 2) return route.abort("connectionreset");
    return route.continue();
  });
  await pickFiles(page, "video", FIX("walkthrough.mp4"));
  const item = page.getByTestId("upload-item");
  // The client retries the chunk itself after reading the server's offset.
  await expect(item).toHaveAttribute("data-status", "done", { timeout: 45_000 });
  expect(patches).toBeGreaterThanOrEqual(3);
});

test("cancelling an upload, then retrying, completes it", async ({ page }) => {
  await signInUI(page, "homeowner2@bmq.test");
  const create = await page.request.post("/api/jobs", {
    headers: { Origin: ORIGIN },
    data: { submissionKey: `upload-cancel-${Date.now()}`, draft: { trade: "bathroom-refit", title: "Upload cancel", description: "", address: { line1: "1 A St", town: "London", postcode: "SE15 1AA" }, quote: { pricePounds: "5000" } } },
  });
  const { id } = (await create.json()) as { id: string };
  await page.goto(`/homeowner/jobs/${id}`);
  let hold = true;
  await page.route("**/api/dev-storage/tus/**", async (route) => {
    if (route.request().method() === "PATCH" && hold) {
      await new Promise((r) => setTimeout(r, 1500));
      return route.continue().catch(() => {});
    }
    return route.continue();
  });
  await pickFiles(page, "video", FIX("walkthrough.mp4"));
  const item = page.getByTestId("upload-item");
  await expect(item).toHaveAttribute("data-status", "uploading");
  await item.getByRole("button", { name: "Cancel" }).click();
  await expect(item).toHaveAttribute("data-status", "cancelled");
  hold = false;
  await item.getByRole("button", { name: "Retry" }).click();
  await expect(item).toHaveAttribute("data-status", "done", { timeout: 45_000 });
});

test("a repeated request with the same idempotency key is replayed, not re-run", async ({ request }) => {
  await apiSignIn(request, "homeowner2@bmq.test");
  const create = await request.post("/api/jobs", {
    headers: { Origin: ORIGIN },
    data: { submissionKey: `idem-${Date.now()}`, draft: { trade: "bathroom-refit", title: "Idempotency", description: "", address: { line1: "1 A St", town: "London", postcode: "SE15 1AA" }, quote: { pricePounds: "5000" } } },
  });
  const { id } = (await create.json()) as { id: string };
  const headers = { Origin: ORIGIN, "Idempotency-Key": `cancel-${Date.now()}` };
  const first = await request.post(`/api/jobs/${id}/cancel`, { headers, data: {} });
  const second = await request.post(`/api/jobs/${id}/cancel`, { headers, data: {} });
  expect(first.status()).toBe(200);
  expect(second.status()).toBe(200);
  expect(second.headers()["idempotent-replayed"]).toBe("true");
  const missing = await request.post(`/api/jobs/${id}/cancel`, { headers: { Origin: ORIGIN }, data: {} });
  expect(missing.status()).toBe(422);
});
