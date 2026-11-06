import { afterAll, describe, expect, it, vi } from "vitest";
import { clearRateLimit, enforceRateLimit } from "@/server/services/rateLimit";
import { runIdempotent } from "@/server/services/idempotency";
import { enqueue, processDueNotifications } from "@/server/services/notificationService";
import { closeDb, pingDatabase, withServiceTx } from "@/server/db/client";
import { resetConfigForTests } from "@/server/config";
import { codeOf, makeUser, sql } from "./helpers";

afterAll(async () => {
  await closeDb();
});

describe("rate limiting", () => {
  it("allows up to the limit, then blocks with a retry time", async () => {
    const rule = { name: `t_${Date.now()}`, max: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) await enforceRateLimit(rule, "ip:1.2.3.4");
    const err = await enforceRateLimit(rule, "ip:1.2.3.4").catch((e) => e);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    await enforceRateLimit(rule, "ip:5.6.7.8"); // other subjects unaffected
  });
  it("can't be bypassed by concurrent requests", async () => {
    const rule = { name: `c_${Date.now()}`, max: 5, windowSeconds: 60 };
    const results = await Promise.all(Array.from({ length: 20 }, () => codeOf(enforceRateLimit(rule, "u:race"))));
    expect(results.filter((r) => r === "OK").length).toBe(5);
  });
  it("stores only hashed subjects", async () => {
    await enforceRateLimit({ name: "hash_check", max: 10, windowSeconds: 60 }, "email:jane@example.com");
    const rows = await sql`select bucket from public.rate_limits where bucket like 'hash_check:%'`;
    expect(JSON.stringify(rows)).not.toContain("jane");
  });
  it("clearing a bucket (after a successful sign-in) resets the count", async () => {
    const rule = { name: `clr_${Date.now()}`, max: 2, windowSeconds: 60 };
    await enforceRateLimit(rule, "email:a@b.test");
    await enforceRateLimit(rule, "email:a@b.test");
    await clearRateLimit(rule, "email:a@b.test");
    await enforceRateLimit(rule, "email:a@b.test");
  });
  it("ignores the test multiplier for sign-in limits and refuses it outside tests", async () => {
    const { RULES } = await import("@/server/services/rateLimit");
    expect("scalableInTests" in RULES.signIn).toBe(false);
    const prev = { m: process.env.RATE_LIMIT_MULTIPLIER, e: process.env.APP_ENV };
    process.env.RATE_LIMIT_MULTIPLIER = "10";
    process.env.APP_ENV = "staging";
    resetConfigForTests();
    const { config } = await import("@/server/config");
    expect(() => config()).toThrow(/RATE_LIMIT_MULTIPLIER/);
    if (prev.m === undefined) delete process.env.RATE_LIMIT_MULTIPLIER; else process.env.RATE_LIMIT_MULTIPLIER = prev.m;
    if (prev.e === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = prev.e;
    resetConfigForTests();
  });
});

describe("idempotency keys", () => {
  it("replays the first response and runs the action once", async () => {
    const u = await makeUser("homeowner");
    const fn = vi.fn(async () => ({ status: 201, body: { id: "abc" } }));
    const a = await runIdempotent(u.id, "key-aaaaaaaa", "POST /x", { a: 1 }, fn);
    const b = await runIdempotent(u.id, "key-aaaaaaaa", "POST /x", { a: 1 }, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(b).toEqual({ ...a, replayed: true });
  });
  it("rejects a different body with the same key, and concurrent duplicates", async () => {
    const u = await makeUser("homeowner");
    await runIdempotent(u.id, "key-bbbbbbbb", "POST /x", { a: 1 }, async () => ({ status: 200, body: {} }));
    expect(await codeOf(runIdempotent(u.id, "key-bbbbbbbb", "POST /x", { a: 2 }, async () => ({ status: 200, body: {} })))).toBe("IDEMPOTENCY_MISMATCH");
    let release!: () => void;
    const slow = runIdempotent(u.id, "key-cccccccc", "POST /y", {}, () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }));
    await new Promise((r) => setTimeout(r, 50));
    expect(await codeOf(runIdempotent(u.id, "key-cccccccc", "POST /y", {}, async () => ({ status: 200, body: {} })))).toBe("IDEMPOTENCY_IN_PROGRESS");
    release();
    await slow;
  });
  it("releases the key after a transient failure so the user can retry", async () => {
    const u = await makeUser("homeowner");
    expect(await codeOf(runIdempotent(u.id, "key-dddddddd", "POST /z", {}, async () => { throw Object.assign(new Error("db down"), { code: "ECONNRESET" }); }))).toBe("ECONNRESET");
    const r = await runIdempotent(u.id, "key-dddddddd", "POST /z", {}, async () => ({ status: 200, body: { ok: true } }));
    expect(r.replayed).toBe(false);
  });
});

describe("notifications outbox", () => {
  it("deduplicates and sends via the configured sender", async () => {
    const u = await makeUser("homeowner");
    await withServiceTx(async (tx) => {
      await enqueue(tx, u.id, "job_submitted", { jobId: "j", title: "T" }, `dedupe-${u.id}`);
      await enqueue(tx, u.id, "job_submitted", { jobId: "j", title: "T" }, `dedupe-${u.id}`);
    });
    expect((await sql`select * from public.notifications where user_id = ${u.id}`).length).toBe(1);
    // Other test files queue notifications too, so drain until ours has been picked up.
    let status = "pending";
    for (let i = 0; i < 20 && status === "pending"; i++) {
      await processDueNotifications(500);
      const [row] = await sql<{ status: string }[]>`select status from public.notifications where user_id = ${u.id}`;
      status = row!.status;
    }
    expect(status).toBe("sent");
  });
  it("a provider outage is retried later, not lost", async () => {
    const u = await makeUser("homeowner");
    await withServiceTx((tx) => enqueue(tx, u.id, "job_submitted", { jobId: "j", title: "T" }, `outage-${u.id}`));
    resetConfigForTests({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test_fake" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    try {
      await processDueNotifications(1000);
    } finally {
      fetchSpy.mockRestore();
      resetConfigForTests({ EMAIL_PROVIDER: "console", RESEND_API_KEY: "" });
    }
    const [n] = await sql<{ status: string; attempts: number; lastError: string }[]>`select status, attempts, last_error from public.notifications where user_id = ${u.id}`;
    expect(n).toMatchObject({ status: "failed", attempts: 1 });
  });
});

describe("health", () => {
  it("reports database health with latency", async () => {
    const r = await pingDatabase();
    expect(r.ok).toBe(true);
  });
});
