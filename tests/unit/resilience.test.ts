import { describe, expect, it, vi } from "vitest";
import { isTransient, TimeoutError, withRetry, withTimeout } from "@/server/domain/resilience";
import { backoffDelayMs } from "@/lib/backoff";

describe("backoff", () => {
  it("grows exponentially, is capped, and is jittered", () => {
    expect(backoffDelayMs(0, 100, 1000, () => 0.999)).toBe(99);
    expect(backoffDelayMs(3, 100, 1000, () => 0.999)).toBe(799);
    expect(backoffDelayMs(10, 100, 1000, () => 0.999)).toBe(999);
    expect(backoffDelayMs(5, 100, 1000, () => 0)).toBe(0);
  });
});

describe("withRetry", () => {
  it("retries only errors the caller marks as safe", async () => {
    const fn = vi.fn().mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ECONNRESET" })).mockResolvedValue("ok");
    await expect(withRetry(fn, { retries: 3, retryOn: isTransient, sleep: async () => {} })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
  it("does not retry non-transient errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("validation"));
    await expect(withRetry(fn, { retries: 3, retryOn: isTransient, sleep: async () => {} })).rejects.toThrow("validation");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("gives up after the retry budget", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNREFUSED" }));
    await expect(withRetry(fn, { retries: 2, retryOn: isTransient, sleep: async () => {} })).rejects.toThrow("down");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("withTimeout", () => {
  it("rejects slow operations and aborts them", async () => {
    let aborted = false;
    await expect(withTimeout("slow", 20, (signal) => new Promise((r) => {
      signal.addEventListener("abort", () => { aborted = true; });
      setTimeout(r, 500);
    }))).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });
  it("passes fast results through", async () => {
    await expect(withTimeout("fast", 200, async () => 7)).resolves.toBe(7);
  });
});
