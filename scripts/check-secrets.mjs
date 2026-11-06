#!/usr/bin/env node
// Scans the repository (and, if built, the browser bundles) for things that look
// like real credentials. Exits non-zero on any finding. Run: npm run audit:secrets
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".dev-storage", "test-results", "playwright-report", "coverage"]);
const SKIP_FILES = new Set([".env.local", "package-lock.json"]);

const PATTERNS = [
  ["Stripe secret/restricted key", /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}/],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{24,}/],
  ["JWT (e.g. Supabase key)", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{16,}/],
  ["Resend API key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/],
  ["Twilio account SID", /\bAC[0-9a-f]{32}\b/],
  ["Twilio API key", /\bSK[0-9a-f]{32}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Postgres URL with a non-local host and password", /postgres(ql)?:\/\/[^:\s/]+:[^@\s<>]{6,}@(?!localhost|127\.0\.0\.1)[^\s"'`]+/],
];

function listFiles() {
  if (existsSync(path.join(ROOT, ".git"))) {
    try {
      const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" });
      return out.split("\n").filter(Boolean);
    } catch {
      /* fall through to a directory walk */
    }
  }
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else files.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  return files;
}

const findings = [];
for (const rel of listFiles()) {
  if (SKIP_FILES.has(path.basename(rel)) || rel.split(path.sep).some((p) => SKIP_DIRS.has(p))) continue;
  const full = path.join(ROOT, rel);
  if (!existsSync(full) || statSync(full).size > 2_000_000) continue;
  const text = readFileSync(full, "utf8");
  if (text.includes("\u0000")) continue; // binary
  for (const [label, re] of PATTERNS) {
    const m = text.match(re);
    if (m) findings.push(`${rel}: ${label} (${m[0].slice(0, 8)}…)`);
  }
}

// Env files with real values must never be committed.
const ignored = existsSync(path.join(ROOT, ".gitignore")) ? readFileSync(path.join(ROOT, ".gitignore"), "utf8") : "";
if (!/^\.env\*?(\.local)?$/m.test(ignored) && !/^\.env\*$/m.test(ignored)) findings.push(".gitignore: .env files are not ignored");

// Server-only settings must never reach the browser bundles.
const staticDir = path.join(ROOT, ".next", "static");
if (existsSync(staticDir)) {
  const SERVER_ONLY = ["SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SESSION_SECRET", "STORAGE_SIGNING_SECRET", "CRON_SECRET", "DATABASE_URL", "TWILIO_AUTH_TOKEN", "RESEND_API_KEY"];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js")) {
        const text = readFileSync(full, "utf8");
        for (const key of SERVER_ONLY) if (text.includes(key)) findings.push(`${path.relative(ROOT, full)}: browser bundle mentions ${key}`);
        for (const [label, re] of PATTERNS) if (re.test(text)) findings.push(`${path.relative(ROOT, full)}: browser bundle contains ${label}`);
      }
    }
  };
  walk(staticDir);
} else {
  console.log("note: no build found, browser bundles not checked (run npm run build first)");
}

if (findings.length) {
  console.error(`secret check FAILED (${findings.length}):\n  ${findings.join("\n  ")}`);
  process.exit(1);
}
console.log("secret check passed: no credential-like strings in the repository or browser bundles");
