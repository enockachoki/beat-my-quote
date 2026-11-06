import { expect, test, type Page } from "@playwright/test";
import { FIX, newSignedInPage, pickFiles, watchConsole } from "./helpers";

/**
 * Complete homeowner -> admin -> builder -> homeowner -> builder journey, in
 * one serial flow because each step depends on the previous one.
 */
test.describe.configure({ mode: "serial" });

let jobUrl = "";
let jobId = "";

async function waitForUploads(page: Page, count: number) {
  await expect(page.locator('[data-testid="upload-item"][data-status="done"]')).toHaveCount(count, { timeout: 30_000 });
}

test("homeowner uploads a quote, photos and a video and submits it", async ({ browser }) => {
  const page = await newSignedInPage(browser, "homeowner@bmq.test");
  const errors = watchConsole(page);
  await page.goto("/homeowner/jobs/new");
  await page.getByLabel("Type of job").selectOption("bathroom-refit");
  await page.getByLabel("Short title").fill("E2E bathroom refit");
  await page.getByLabel("Quote total, including VAT (£)").fill("8,640.00");
  await page.getByLabel("Company that quoted (optional)").fill("Rival Bathrooms Ltd");
  await page.getByLabel("Address line 1").fill("12 Hidden Road");
  await page.getByLabel("Town or city").fill("London");
  await page.getByLabel("Postcode").fill("se15 4aa");
  await page.getByRole("button", { name: "Save and add photos" }).click();
  await page.waitForURL(/\/homeowner\/jobs\/[0-9a-f-]{36}$/);
  jobUrl = page.url();
  jobId = jobUrl.split("/").pop()!;

  await pickFiles(page, "quote_document", FIX("quote.pdf"));
  await pickFiles(page, "photo", [FIX("photo1.jpg"), FIX("photo2.jpg"), FIX("photo3.jpg")]);
  await pickFiles(page, "video", FIX("walkthrough.mp4"));
  await waitForUploads(page, 5);

  // Submitting without the consents is blocked on the client (and on the server).
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("alert").first()).toContainText("isn't complete");
  for (const cb of await page.getByRole("checkbox").all()) await cb.check();
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByTestId("job-status")).toHaveText("Submitted for review");
  expect(errors).toEqual([]);
});

test("admin reviews, uploads a redacted quote and approves", async ({ browser }) => {
  const page = await newSignedInPage(browser, "admin@bmq.test");
  const errors = watchConsole(page);
  await page.goto("/admin");
  await page.getByRole("link", { name: "E2E bathroom refit" }).click();
  await expect(page.getByText("Rival Bathrooms Ltd")).toBeVisible(); // admin sees private details
  await page.getByTestId("start-review").click();
  await expect(page.getByTestId("job-status")).toHaveText("Being reviewed");
  await pickFiles(page, "quote_redacted", FIX("redacted.pdf"));
  await waitForUploads(page, 1);
  await page.getByRole("button", { name: "Refresh media list" }).click();
  await page.getByLabel("Standard scope (shown to builders)").fill("Strip out existing bathroom. Supply and fit suite with shower over bath. Tile walls and floor (14 m²).");
  await expect(page.getByTestId("beat-price")).toHaveText("£7,948.00");
  // The original quote is never offered for publishing.
  await expect(page.getByRole("checkbox", { name: /quote\.pdf/ })).toHaveCount(0);
  for (const name of [/Redacted quote/, /photo1\.jpg/, /photo2\.jpg/]) await page.getByRole("checkbox", { name }).check();
  await page.getByTestId("approve-job").click();
  await expect(page.getByTestId("job-status")).toHaveText("Offered to our crews");
  expect(errors).toEqual([]);
});

test("partner can't see it during crew first refusal; crew takes it (double-click safe)", async ({ browser }) => {
  const partner = await newSignedInPage(browser, "partner@bmq.test");
  await partner.goto("/builder");
  await expect(partner.getByRole("link", { name: "E2E bathroom refit" })).toHaveCount(0);
  await partner.goto(`/builder/jobs/${jobId}`);
  await expect(partner.getByRole("heading", { name: "Page not found" })).toBeVisible();
  expect((await partner.request.get(`/api/builder/jobs/${jobId}`)).status()).toBe(404);

  const crew = await newSignedInPage(browser, "crew@bmq.test");
  const errors = watchConsole(crew);
  await crew.goto("/builder");
  await crew.getByRole("link", { name: "E2E bathroom refit" }).click();
  await expect(crew.getByText("Shared once the homeowner accepts your offer")).toBeVisible();
  await expect(crew.getByText("Rival Bathrooms Ltd")).toHaveCount(0);
  await expect(crew.getByText("12 Hidden Road")).toHaveCount(0);
  // Images shown to builders are the metadata-stripped copies via short-lived signed URLs.
  const img = crew.locator(".media-grid img").first();
  await expect(img).toBeVisible();
  const claim = crew.getByTestId("claim-job");
  await claim.dblclick();
  await expect(crew.getByTestId("job-status")).toHaveText("Offer waiting for you");
  expect(errors).toEqual([]);
});

test("homeowner accepts the offer and pays the deposit; paid only after verification", async ({ browser }) => {
  const page = await newSignedInPage(browser, "homeowner@bmq.test");
  const errors = watchConsole(page);
  await page.goto(jobUrl);
  await page.getByTestId("accept-offer").click();
  await expect(page.getByText("Please agree to the Job Contract").first()).toBeVisible();
  await page.getByRole("checkbox", { name: /I agree to the Job Contract/ }).check();
  await page.getByTestId("accept-offer").click();
  await expect(page.getByTestId("job-status")).toHaveText("Waiting for deposit");
  await page.getByTestId("pay-deposit").click();
  await page.waitForURL(/\/dev\/fake-checkout\//);
  // Simulate the provider's webhook being lost: the return page must verify with the provider.
  await page.getByTestId("fake-pay-lost-webhook").click();
  await page.waitForURL(/\/payment\//);
  await expect(page.getByText("Deposit received")).toBeVisible({ timeout: 30_000 });
  await page.goto(jobUrl);
  await expect(page.getByTestId("job-status")).toHaveText("Deposit paid");
  expect(errors).toEqual([]);
});

test("builder sees the address, can't start before the pre-start check, then starts", async ({ browser }) => {
  const crew = await newSignedInPage(browser, "crew@bmq.test");
  await crew.goto(`/builder/jobs/${jobId}`);
  await expect(crew.getByTestId("job-address")).toContainText("12 Hidden Road");
  await crew.getByTestId("start-work").click();
  await expect(crew.getByRole("alert").first()).toContainText("can't start");
  await crew.getByRole("button", { name: "Record pre-start check" }).click();
  await expect(crew.getByText("Pre-start check recorded")).toBeVisible();
  await crew.getByTestId("start-work").click();
  await expect(crew.getByTestId("job-status")).toHaveText("Work in progress");
});
