"use client";

import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { ApiError } from "./api";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label} />;
}

export function Button({ busy, children, variant = "primary", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: "primary" | "secondary" | "danger" }) {
  return (
    <button {...rest} className={`btn btn-${variant} ${rest.className ?? ""}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy ? <Spinner label="Working" /> : null}
      <span>{children}</span>
    </button>
  );
}

interface FieldProps { label: string; error?: string; hint?: string; children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode }
export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={`field ${error ? "field-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="hint" id={hintId}>{hint}</p> : null}
      {error ? <p className="error-text" id={errId}>{error}</p> : null}
      {children({ id, describedBy: [hintId, errId].filter(Boolean).join(" ") || undefined, invalid: !!error })}
    </div>
  );
}

export function TextInput({ label, error, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{({ id, describedBy, invalid }) => <input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />}</Field>;
}

export function TextArea({ label, error, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{({ id, describedBy, invalid }) => <textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest} />}</Field>;
}

export function Select({ label, error, hint, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string; hint?: string }) {
  return <Field label={label} error={error} hint={hint}>{({ id, describedBy, invalid }) => <select id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined} {...rest}>{children}</select>}</Field>;
}

export function Checkbox({ label, error, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; error?: string }) {
  const id = useId();
  return (
    <div className={`check ${error ? "field-error" : ""}`}>
      <input type="checkbox" id={id} aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-err` : undefined} {...rest} />
      <label htmlFor={id}>{label}</label>
      {error ? <p className="error-text" id={`${id}-err`}>{error}</p> : null}
    </div>
  );
}

/** Accessible error summary; moves focus to itself so screen readers announce it. */
export function ErrorSummary({ error, title = "There is a problem" }: { error: ApiError | null; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  if (!error) return null;
  const fields = Object.entries(error.fields ?? {});
  return (
    <div className="alert alert-error" role="alert" tabIndex={-1} ref={ref}>
      <strong>{title}</strong>
      <p>{error.message}</p>
      {fields.length ? <ul>{fields.map(([k, v]) => <li key={k}>{v}</li>)}</ul> : null}
      {error.requestId && error.status >= 500 ? <p className="small">Reference: {error.requestId}</p> : null}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "success" | "warning"; children: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === "warning" ? "alert" : "status"}>{children}</div>;
}
