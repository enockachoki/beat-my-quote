import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import { signToken, verifyToken } from "@/server/storage/signing";
import { parseSession, signSession } from "@/server/auth/devAuth";
import { FakePaymentProvider } from "@/server/payments/fake";

const SECRET = "unit-test-secret-unit-test-secret-0000";

describe("storage tokens", () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  it("verifies valid tokens for the right operation only", () => {
    const t = signToken(SECRET, { p: "jobs/a/b.jpg", op: "put", exp, max: 10 });
    expect(verifyToken(SECRET, t, "put")?.p).toBe("jobs/a/b.jpg");
    expect(verifyToken(SECRET, t, "get")).toBeNull();
    expect(verifyToken("other-secret-other-secret-other-000", t, "put")).toBeNull();
  });
  it("rejects expired, tampered and path-traversal tokens", () => {
    expect(verifyToken(SECRET, signToken(SECRET, { p: "x", op: "get", exp: 1 }), "get")).toBeNull();
    const t = signToken(SECRET, { p: "jobs/a.jpg", op: "get", exp });
    const [body, mac] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "jobs/other.jpg", op: "get", exp })).toString("base64url");
    expect(verifyToken(SECRET, `${forged}.${mac}`, "get")).toBeNull();
    expect(verifyToken(SECRET, `${body}.AAAA`, "get")).toBeNull();
    expect(verifyToken(SECRET, signToken(SECRET, { p: "../../etc/passwd", op: "get", exp }), "get")).toBeNull();
  });
  it("rejects a token whose last signature character is altered (spare base64 bits)", () => {
    for (let i = 0; i < 50; i++) {
      const t = signToken(SECRET, { p: `jobs/a/${i}.jpg`, op: "put", exp });
      for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
        if (c === t.at(-1)) continue;
        expect(verifyToken(SECRET, t.slice(0, -1) + c, "put")).toBeNull();
      }
    }
  });
});

describe("dev session cookies", () => {
  it("detects expiry separately from tampering", () => {
    const now = Math.floor(Date.now() / 1000);
    const ok = signSession(SECRET, { sub: "u1", email: "a@b", iat: now, exp: now + 60, sid: "s" });
    expect(parseSession(SECRET, ok)).toEqual({ state: "active", identity: { id: "u1", email: "a@b" } });
    expect(parseSession(SECRET, signSession(SECRET, { sub: "u1", email: "a@b", iat: now - 100, exp: now - 1, sid: "s" })).state).toBe("expired");
    for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
      if (c !== ok.at(-1)) expect(parseSession(SECRET, ok.slice(0, -1) + c).state).toBe("none");
    }
    expect(parseSession("another-secret-another-secret-0000", ok).state).toBe("none");
  });
});

describe("payment webhook signatures", () => {
  const provider = new FakePaymentProvider("whsec_unit_test", "http://localhost:3000");
  const stripe = new Stripe("sk_test_x");
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", amount_total: 100, metadata: { payment_id: "p1" } } } });
  it("accepts correctly signed events", () => {
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_unit_test" });
    expect(provider.verifyWebhook(payload, sig)).toMatchObject({ id: "evt_1", sessionId: "cs_1", paymentId: "p1", amountTotal: 100 });
  });
  it("rejects missing, wrong-secret and tampered signatures", () => {
    expect(() => provider.verifyWebhook(payload, null)).toThrow();
    const wrong = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_attacker" });
    expect(() => provider.verifyWebhook(payload, wrong)).toThrow();
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_unit_test" });
    expect(() => provider.verifyWebhook(payload.replace('"amount_total":100', '"amount_total":1'), sig)).toThrow();
  });
  it("rejects replayed (old) signatures", () => {
    const old = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_unit_test", timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => provider.verifyWebhook(payload, old)).toThrow();
  });
});
