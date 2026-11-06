"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatGBP } from "@/lib/money";
import { prestartSchema, variationSchema } from "@/lib/schemas";
import { api } from "../api";
import { useSubmit } from "../useSubmit";
import { Button, Checkbox, ErrorSummary, Notice, Select, TextArea, TextInput } from "../ui";

/** A single server action button with duplicate protection and idempotency. */
export function ActionButton({ endpoint, body, label, variant = "primary", confirm, onDone, testId }: { endpoint: string; body?: unknown; label: string; variant?: "primary" | "secondary" | "danger"; confirm?: string; onDone?: (data: unknown) => void; testId?: string }) {
  const router = useRouter();
  const { run, busy, error } = useSubmit(useCallback((key: string) => api(endpoint, { method: "POST", idempotencyKey: key, body: body ?? {} }), [endpoint, body]));
  return (
    <div>
      <ErrorSummary error={error} title="That didn't work" />
      <Button
        type="button"
        variant={variant}
        busy={busy}
        data-testid={testId}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          const r = await run();
          if (r?.ok) {
            if (onDone) onDone(r.data);
            else router.refresh();
          }
        }}
      >
        {label}
      </Button>
    </div>
  );
}

export function OfferDecision({ offerId, termsVersion, pricePence, expiresAt }: { offerId: string; termsVersion: string; pricePence: number; expiresAt: string }) {
  const [agree, setAgree] = useState(false);
  const router = useRouter();
  const { run, busy, error, setError } = useSubmit(useCallback((key: string, decision: "accept" | "decline") =>
    api(`/api/offers/${offerId}/decision`, { method: "POST", idempotencyKey: key, body: decision === "accept" ? { decision, termsVersion, agreeToContract: true } : { decision } }), [offerId, termsVersion]));
  return (
    <div className="card">
      <h2>A vetted builder will do this job for {formatGBP(pricePence)}</h2>
      <p className="small">This offer expires {new Date(expiresAt).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "medium", timeStyle: "short" })}.</p>
      <ErrorSummary error={error} />
      <Checkbox
        checked={agree}
        onChange={(e) => setAgree(e.target.checked)}
        error={error?.fields?.agreeToContract}
        label={<>I agree to the Job Contract (terms version {termsVersion}, draft wording for solicitor review) with this builder at a fixed price of {formatGBP(pricePence)} including VAT. My address will be shared with this builder.</>}
      />
      <div className="row">
        <Button busy={busy} data-testid="accept-offer" onClick={async () => {
          if (!agree) return setError({ code: "VALIDATION_FAILED", message: "Please agree to the Job Contract.", fields: { agreeToContract: "Please agree to the Job Contract" }, status: 422 });
          const r = await run("accept");
          if (r?.ok) router.refresh();
        }}>Accept offer</Button>
        <Button variant="secondary" busy={busy} onClick={async () => {
          if (!window.confirm("Decline this offer? We'll offer the job to other builders.")) return;
          const r = await run("decline");
          if (r?.ok) router.refresh();
        }}>Decline</Button>
      </div>
    </div>
  );
}

export function DepositButton({ jobId, depositPence }: { jobId: string; depositPence: number }) {
  const { run, busy, error } = useSubmit(useCallback((key: string) => api<{ url: string }>(`/api/jobs/${jobId}/deposit`, { method: "POST", idempotencyKey: key, body: {}, timeoutMs: 30_000 }), [jobId]));
  return (
    <div className="card">
      <h2>Pay your deposit of {formatGBP(depositPence)}</h2>
      <p>Your deposit is held securely by our payment provider until work starts. Never pay a builder in cash or outside the platform.</p>
      <ErrorSummary error={error} title="Payment couldn't start" />
      <Button busy={busy} data-testid="pay-deposit" onClick={async () => {
        const r = await run();
        if (r?.ok) window.location.assign(r.data.url);
      }}>Pay deposit securely</Button>
    </div>
  );
}

/**
 * After returning from the payment page we never assume success: we ask the
 * server, which checks with the payment provider, with backoff for up to ~90s.
 */
export function PaymentStatus({ paymentId, jobId }: { paymentId: string; jobId: string }) {
  const [status, setStatus] = useState<string>("checking");
  const [failed, setFailed] = useState(false);
  const attempts = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const r = await api<{ status: string }>(`/api/payments/${paymentId}`);
      if (cancelled) return;
      if (r.ok) setStatus(r.data.status);
      else setFailed(true);
      const final = r.ok && ["succeeded", "failed", "cancelled", "refunded"].includes(r.data.status);
      if (!final && attempts.current++ < 12) timer = setTimeout(tick, Math.min(15_000, 1500 * 2 ** Math.min(attempts.current, 3)));
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paymentId]);
  return (
    <div className="card" aria-live="polite">
      {status === "succeeded" ? <Notice kind="success">Deposit received. It&apos;s held securely until work starts.</Notice>
        : status === "cancelled" || status === "failed" ? <Notice kind="warning">The payment didn&apos;t go through. Nothing has been taken. You can try again from your job page.</Notice>
        : <Notice>We&apos;re confirming your payment with our payment provider. This usually takes a few seconds. You can leave this page; we&apos;ll update your job when it&apos;s confirmed.</Notice>}
      {failed ? <p className="small">We couldn&apos;t check just now. Your job page will show the confirmed status.</p> : null}
      <a className="btn btn-secondary" href={`/homeowner/jobs/${jobId}`}>Back to my job</a>
    </div>
  );
}

export function VariationDecision({ variationId, reason, amountPence }: { variationId: string; reason: string; amountPence: number }) {
  const router = useRouter();
  const { run, busy, error } = useSubmit(useCallback((key: string, decision: "approve" | "decline") => api(`/api/variations/${variationId}/decision`, { method: "POST", idempotencyKey: key, body: { decision } }), [variationId]));
  const ends = reason === "not_reasonably_visible";
  return (
    <div>
      <ErrorSummary error={error} />
      <div className="row">
        <Button busy={busy} onClick={async () => { const r = await run("approve"); if (r?.ok) router.refresh(); }}>Approve {amountPence > 0 ? "+" : ""}{formatGBP(amountPence)}</Button>
        <Button variant="danger" busy={busy} onClick={async () => {
          if (!window.confirm(ends ? "If you decline, the contract ends and your deposit is refunded in full. Continue?" : "Decline this extra work? The agreed price stays the same.")) return;
          const r = await run("decline");
          if (r?.ok) router.refresh();
        }}>Decline</Button>
      </div>
    </div>
  );
}

export function PrestartForm({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<"confirmed" | "variation_required">("confirmed");
  const [notes, setNotes] = useState("");
  const { run, busy, error, setError } = useSubmit(useCallback((key: string, body: unknown) => api(`/api/builder/jobs/${jobId}/prestart`, { method: "POST", idempotencyKey: key, body }), [jobId]));
  return (
    <form className="card" noValidate onSubmit={async (e) => {
      e.preventDefault();
      const p = prestartSchema.safeParse({ outcome, notes });
      if (!p.success) return setError({ code: "VALIDATION_FAILED", message: "Some details need correcting.", status: 422 });
      const r = await run(p.data);
      if (r?.ok) router.refresh();
    }}>
      <h2>Pre-start check</h2>
      <p className="small">Confirm the site matches the uploads and the standard scope. This is not a quote visit.</p>
      <ErrorSummary error={error} />
      <Select label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
        <option value="confirmed">Site matches the uploads and scope</option>
        <option value="variation_required">Found something not reasonably visible in the uploads</option>
      </Select>
      <TextArea label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
      <Button type="submit" busy={busy}>Record pre-start check</Button>
    </form>
  );
}

export function VariationForm({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [v, setV] = useState({ reason: "not_reasonably_visible", description: "", amountPounds: "" });
  const { run, busy, error, setError } = useSubmit(useCallback((key: string, body: unknown) => api(`/api/builder/jobs/${jobId}/variations`, { method: "POST", idempotencyKey: key, body }), [jobId]));
  return (
    <form className="card" noValidate onSubmit={async (e) => {
      e.preventDefault();
      const p = variationSchema.safeParse(v);
      if (!p.success) {
        const fields: Record<string, string> = {};
        for (const i of p.error.issues) fields[String(i.path[0])] ??= i.message;
        return setError({ code: "VALIDATION_FAILED", message: "Some details need correcting.", fields, status: 422 });
      }
      const r = await run(v);
      if (r?.ok) {
        setV({ reason: "not_reasonably_visible", description: "", amountPounds: "" });
        router.refresh();
      }
    }}>
      <h2>Written Variation Form</h2>
      <p className="small">Only for something not reasonably visible in the uploads, or extra work the homeowner asked for. The price doesn&apos;t change unless the homeowner approves. Do not start this work before approval.</p>
      <ErrorSummary error={error} />
      <Select label="Reason" value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })}>
        <option value="not_reasonably_visible">Not reasonably visible in the uploads</option>
        <option value="homeowner_requested">Extra work the homeowner asked for</option>
      </Select>
      <TextArea label="What did you find, and what work is needed?" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} error={error?.fields?.description} maxLength={4000} />
      <TextInput label="Change to the price, inc VAT (£). Use - for a reduction." inputMode="decimal" value={v.amountPounds} onChange={(e) => setV({ ...v, amountPounds: e.target.value })} error={error?.fields?.amountPounds} />
      <Button type="submit" busy={busy}>Send to homeowner</Button>
    </form>
  );
}
