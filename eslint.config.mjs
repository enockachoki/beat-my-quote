import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "next-env.d.ts", ".dev-storage/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    files: ["scripts/**", "tests/**", "src/server/observability/logger.ts", "src/server/auth/devAuth.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Client components must never import server-only modules.
    files: ["src/components/**", "src/app/**/*.client.tsx"],
    rules: {
      "no-restricted-imports": ["error", { patterns: ["@/server/*"] }],
    },
  },
];

export default config;
