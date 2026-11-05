import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "tests/stubs/server-only.ts") } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node", env: { APP_ENV: "test", LOG_LEVEL: "error" } },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/integration/global-setup.ts"],
          env: {
            APP_ENV: "test",
            DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/bmq_it",
            AUTH_PROVIDER: "dev",
            STORAGE_PROVIDER: "local",
            PAYMENT_PROVIDER: "fake",
            SESSION_SECRET: "integration-test-session-secret-0123456789abcdef",
            STORAGE_SIGNING_SECRET: "integration-test-storage-secret-0123456789abcdef",
            FAKE_PAYMENT_WEBHOOK_SECRET: "whsec_integration_test_secret",
            LOCAL_STORAGE_DIR: ".dev-storage/integration",
            LOG_LEVEL: "error",
            CREW_WINDOW_HOURS: "24",
            MINIMUM_JOB_PRICE_PENCE: "50000",
          },
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
