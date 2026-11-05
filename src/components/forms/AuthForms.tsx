"use client";

import { useState } from "react";
import Link from "next/link";
import { signInSchema, signUpSchema, resetConfirmSchema, resetRequestSchema } from "@/lib/schemas";
import { api, type ApiError } from "../api";
import { useSubmit } from "../useSubmit";
import { Button, Checkbox, ErrorSummary, Notice, Select, TextInput } from "../ui";

const HOME: Record<string, string> = { homeowner: "/homeowner", builder: "/builder", admin: "/admin" };

function localError(fields: Record<string, string>): ApiError {
  return { code: "VALIDATION_FAILED", message: "Some details need correcting.", fields, status: 422 };
}

function zodFields(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) out[i.path.map(String).join(".") || "_"] ??= i.message;
  return out;
}

/** Only allow same-site relative redirects after sign-in (no open redirects). */
function safeNext(next: string | null, fallback: string): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : fallback;
}

export function SignInForm({ next, expired }: { next: string | null; expired: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { run, busy, error, setError } = useSubmit((_k: string) => api<{ role: string }>("/api/auth/sign-in", { method: "POST", body: { email, password } }));
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const parsed = signInSchema.safeParse({ email, password });
        if (!parsed.success) return setError(localError(zodFields(parsed.error.issues)));
        const r = await run();
        if (r?.ok) window.location.assign(safeNext(next, HOME[r.data.role] ?? "/"));
      }}
    >
      {expired ? <Notice kind="warning">Your session expired. Please sign in again; we&apos;ll take you back to where you were.</Notice> : null}
      <ErrorSummary error={error} />
      <TextInput label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={error?.fields?.email} required />
      <TextInput label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={error?.fields?.password} required />
      <div className="row between">
        <Button type="submit" busy={busy}>Sign in</Button>
        <Link href="/forgot-password">Forgotten your password?</Link>
      </div>
    </form>
  );
}

export function SignUpForm({ defaultType }: { defaultType: "homeowner" | "builder" }) {
  const [form, setForm] = useState({ fullName: "", email: "", password: "", accountType: defaultType });
  const [terms, setTerms] = useState(false);
  const { run, busy, error, setError } = useSubmit((_k: string) => api<{ role: string }>("/api/auth/sign-up", { method: "POST", body: form }));
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const parsed = signUpSchema.safeParse(form);
        const fields = parsed.success ? {} : zodFields(parsed.error.issues);
        if (!terms) fields.terms = "Please accept the terms to continue";
        if (Object.keys(fields).length) return setError(localError(fields));
        const r = await run();
        if (r?.ok) window.location.assign(r.data.role === "builder" ? "/builder/apply" : "/homeowner/jobs/new");
      }}
    >
      <ErrorSummary error={error} />
      <Select label="I am" value={form.accountType} onChange={set("accountType")}>
        <option value="homeowner">A homeowner with a quote</option>
        <option value="builder">A builder</option>
      </Select>
      <TextInput label="Full name" autoComplete="name" value={form.fullName} onChange={set("fullName")} error={error?.fields?.fullName} />
      <TextInput label="Email" type="email" autoComplete="email" value={form.email} onChange={set("email")} error={error?.fields?.email} />
      <TextInput label="Password" type="password" autoComplete="new-password" hint="At least 10 characters." value={form.password} onChange={set("password")} error={error?.fields?.password} />
      <Checkbox
        checked={terms}
        onChange={(e) => setTerms(e.target.checked)}
        error={error?.fields?.terms}
        label={<>I have read and accept the <Link href="/terms">Terms of Use</Link> and have read the <Link href="/privacy">Privacy Notice</Link> (draft wording).</>}
      />
      <Button type="submit" busy={busy}>Create account</Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { run, busy, error, setError } = useSubmit((_k: string) => api("/api/auth/reset-request", { method: "POST", body: { email } }));
  if (sent) return <Notice kind="success">If an account exists for that email, we&apos;ve sent a link to reset your password. It expires in 30 minutes.</Notice>;
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const parsed = resetRequestSchema.safeParse({ email });
        if (!parsed.success) return setError(localError(zodFields(parsed.error.issues)));
        const r = await run();
        if (r?.ok) setSent(true);
      }}
    >
      <ErrorSummary error={error} />
      <TextInput label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={error?.fields?.email} />
      <Button type="submit" busy={busy}>Send reset link</Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const { run, busy, error, setError } = useSubmit((_k: string) => api("/api/auth/reset-confirm", { method: "POST", body: { token, password } }));
  if (done) return <Notice kind="success">Your password has been changed. <Link href="/sign-in">Sign in</Link></Notice>;
  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const parsed = resetConfirmSchema.safeParse({ token, password });
        if (!parsed.success) return setError(localError(zodFields(parsed.error.issues)));
        const r = await run();
        if (r?.ok) setDone(true);
      }}
    >
      <ErrorSummary error={error} />
      <TextInput label="New password" type="password" autoComplete="new-password" hint="At least 10 characters." value={password} onChange={(e) => setPassword(e.target.value)} error={error?.fields?.password} />
      <Button type="submit" busy={busy}>Change password</Button>
    </form>
  );
}
