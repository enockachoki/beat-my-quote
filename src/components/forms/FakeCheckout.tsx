"use client";

import { useState } from "react";
import { Button, Notice } from "../ui";

/** DEV ONLY companion to the fake checkout page. */
export function FakeCheckoutButtons({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pay = async (skipWebhook: boolean) => {
    setBusy(true);
    const res = await fetch(`/api/dev/fake-checkout/${sessionId}${skipWebhook ? "?skipWebhook=1" : ""}`, { method: "POST" });
    setBusy(false);
    if (!res.ok) return setMsg("This test session is no longer open.");
    const data = (await res.json()) as { successUrl?: string };
    setMsg("Paid. Taking you back…");
    if (data.successUrl && new URL(data.successUrl).origin === window.location.origin) window.location.assign(data.successUrl);
  };
  return (
    <div className="stack">
      {msg ? <Notice kind="success">{msg}</Notice> : null}
      <div className="row">
        <Button busy={busy} data-testid="fake-pay" onClick={() => void pay(false)}>Pay (test)</Button>
        <Button variant="secondary" busy={busy} data-testid="fake-pay-lost-webhook" onClick={() => void pay(true)}>Pay but lose the webhook (test)</Button>
      </div>
    </div>
  );
}
