import "server-only";
import { config } from "../config";
import { log } from "../observability/logger";
import { withTimeout } from "../domain/resilience";

export interface OutboundMessage { to: string; subject?: string; text: string }
export interface Sender { readonly name: string; send(msg: OutboundMessage): Promise<void> }

class ConsoleSender implements Sender {
  constructor(readonly name: string) {}
  async send(msg: OutboundMessage) {
    // Dev only: log the template output without the recipient address.
    log.info("notification.console", { channel: this.name, subject: msg.subject, text: msg.text.slice(0, 300) });
  }
}

/** Resend email via HTTPS. Status: implemented, unverified (needs RESEND_API_KEY). */
class ResendSender implements Sender {
  readonly name = "resend";
  constructor(private readonly apiKey: string, private readonly from: string) {}
  async send(msg: OutboundMessage) {
    const res = await withTimeout("resend.send", 10_000, (signal) =>
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject ?? "Beat My Quote", text: msg.text }),
        signal,
      }),
    );
    if (!res.ok) throw Object.assign(new Error(`resend ${res.status}`), { code: res.status >= 500 || res.status === 429 ? "TRANSIENT" : "PERMANENT" });
  }
}

/** Twilio SMS via HTTPS. Status: implemented, unverified (needs Twilio credentials). */
class TwilioSender implements Sender {
  readonly name = "twilio";
  constructor(private readonly sid: string, private readonly token: string, private readonly from: string) {}
  async send(msg: OutboundMessage) {
    const body = new URLSearchParams({ To: msg.to, From: this.from, Body: msg.text.slice(0, 600) });
    const res = await withTimeout("twilio.send", 10_000, (signal) =>
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.sid)}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal,
      }),
    );
    if (!res.ok) throw Object.assign(new Error(`twilio ${res.status}`), { code: res.status >= 500 || res.status === 429 ? "TRANSIENT" : "PERMANENT" });
  }
}

export function emailSender(): Sender {
  const cfg = config();
  if (cfg.EMAIL_PROVIDER === "resend" && cfg.RESEND_API_KEY) return new ResendSender(cfg.RESEND_API_KEY, cfg.EMAIL_FROM);
  return new ConsoleSender("email-console");
}

export function smsSender(): Sender {
  const cfg = config();
  if (cfg.SMS_PROVIDER === "twilio" && cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_FROM) return new TwilioSender(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_AUTH_TOKEN, cfg.TWILIO_FROM);
  return new ConsoleSender("sms-console");
}
