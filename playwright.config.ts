import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;
export const E2E_ENV = {
  APP_ENV: "test",
  APP_ORIGIN: `http://localhost:${PORT}`,
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bmq_e2e",
  AUTH_PROVIDER: "dev",
  STORAGE_PROVIDER: "local",
  PAYMENT_PROVIDER: "fake",
  LOCAL_STORAGE_DIR: ".dev-storage/e2e",
  SESSION_SECRET: "e2e-session-secret-e2e-session-secret-0123456789",
  STORAGE_SIGNING_SECRET: "e2e-storage-secret-e2e-storage-secret-0123456789",
  FAKE_PAYMENT_WEBHOOK_SECRET: "whsec_e2e_only_secret",
  CRON_SECRET: "e2e-cron-secret-e2e-cron-secret-0123456789",
  LOG_LEVEL: "warn",
  RATE_LIMIT_MULTIPLIER: "20",
};

// Use a pre-installed Chromium when one is provided (e.g. CI images); otherwise Playwright's own.
const launchOptions = process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1, // journeys share one disposable database
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "off" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions }, testMatch: /smoke\.spec\.ts/ },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: E2E_ENV,
    stdout: "pipe",
    stderr: "pipe",
  },
});
