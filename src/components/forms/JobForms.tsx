"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { jobDraftSchema, TRADES, TRADE_LABELS, type JobDraftInput } from "@/lib/schemas";
import { api, newIdempotencyKey, type ApiError } from "../api";
import { useSubmit } from "../useSubmit";
import { Button, Checkbox, ErrorSummary, Notice, Select, TextArea, TextInput } from "../ui";
import { MediaUploader, type ExistingMedia } from "../MediaUploader";

const DRAFT_KEY = "bmq.jobDraft.v1";
const SUBMISSION_KEY = "bmq.jobDraft.submissionKey";

type FormState = { trade: string; title: string; description: string; line1: string; line2: string; town: string; postcode: string; pricePounds: string; rivalCompanyName: string; quoteDate: string };
const EMPTY: FormState = { trade: "", title: "", description: "", line1: "", line2: "", town: "", postcode: "", pricePounds: "", rivalCompanyName: "", quoteDate: "" };

function toInput(f: FormState): JobDraftInput {
  return {
    trade: f.trade as JobDraftInput["trade"], title: f.title, description: f.description,
    address: { line1: f.line1, line2: f.line2, town: f.town, postcode: f.postcode },
    quote: { pricePounds: f.pricePounds, rivalCompanyName: f.rivalCompanyName, quoteDate: f.quoteDate },
  };
}

function fieldsFromZod(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const map: Record<string, string> = { "address.line1": "line1", "address.line2": "line2", "address.town": "town", "address.postcode": "postcode", "quote.pricePounds": "pricePounds", "quote.rivalCompanyName": "rivalCompanyName", "quote.quoteDate": "quoteDate" };
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path.map(String).join(".");
    out[map[k] ?? k] ??= i.message;
  }
  return out;
}

function readLocal<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function writeLocal(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the form still works, it just won't survive a refresh
  }
}

function DetailsFields({ f, set, errors }: { f: FormState; set: (k: keyof FormState) => (e: { target: { value: string } }) => void; errors: Record<string, string> }) {
  return (
    <>
      <fieldset className="card">
        <legend><h2>The job</h2></legend>
        <Select label="Type of job" value={f.trade} onChange={set("trade")} error={errors.trade}>
          <option value="">Choose one</option>
          {TRADES.map((t) => <option key={t} value={t}>{TRADE_LABELS[t]}</option>)}
        </Select>
        <TextInput label="Short title" hint="For example: Full bathroom refit, first floor" value={f.title} onChange={set("title")} error={errors.title} maxLength={120} />
        <TextArea label="Anything else builders should know? (optional)" value={f.description} onChange={set("description")} error={errors.description} maxLength={4000} />
      </fieldset>
      <fieldset className="card">
        <legend><h2>Your quote</h2></legend>
        <TextInput label="Quote total, including VAT (£)" inputMode="decimal" value={f.pricePounds} onChange={set("pricePounds")} error={errors.pricePounds} />
        <TextInput label="Company that quoted (optional)" hint="Only our reviewers see this. It is never shown to builders." value={f.rivalCompanyName} onChange={set("rivalCompanyName")} error={errors.rivalCompanyName} />
        <TextInput label="Date of the quote (optional)" type="date" value={f.quoteDate} onChange={set("quoteDate")} error={errors.quoteDate} />
      </fieldset>
      <fieldset className="card">
        <legend><h2>Where is the job?</h2></legend>
        <p className="hint">Your full address stays hidden until you accept an offer. Builders only see the postcode district (for example SE15).</p>
        <TextInput label="Address line 1" autoComplete="address-line1" value={f.line1} onChange={set("line1")} error={errors.line1} />
        <TextInput label="Address line 2 (optional)" autoComplete="address-line2" value={f.line2} onChange={set("line2")} error={errors.line2} />
        <TextInput label="Town or city" autoComplete="address-level2" value={f.town} onChange={set("town")} error={errors.town} />
        <TextInput label="Postcode" autoComplete="postal-code" value={f.postcode} onChange={set("postcode")} error={errors.postcode} />
      </fieldset>
    </>
  );
}

/**
 * Step 1: job details. Entries are saved in the browser as the user types and
 * restored after a refresh or crash. The draft is created on the server with a
 * stable submission key, so a retry after a timeout never creates two jobs.
 */
export function NewJobForm() {
  const router = useRouter();
  // Rendered client-only (see NewJobFormClient), so reading storage at init is safe.
  const [initial] = useState(() => readLocal<FormState>(DRAFT_KEY));
  const [f, setF] = useState<FormState>(() => ({ ...EMPTY, ...(initial ?? {}) }));
  const restored = initial !== null;
  useEffect(() => {
    if (f !== EMPTY) writeLocal(DRAFT_KEY, f);
  }, [f]);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = useCallback(async (_key: string, draft: unknown) => {
    let submissionKey = readLocal<string>(SUBMISSION_KEY);
    if (!submissionKey) {
      submissionKey = newIdempotencyKey();
      writeLocal(SUBMISSION_KEY, submissionKey);
    }
    return api<{ id: string }>("/api/jobs", { method: "POST", body: { submissionKey, draft }, retrySafe: true });
  }, []);
  const { run, busy, error, setError } = useSubmit(submit);

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const parsed = jobDraftSchema.safeParse(toInput(f));
        if (!parsed.success) return setError({ code: "VALIDATION_FAILED", message: "Some details need correcting.", fields: fieldsFromZod(parsed.error.issues), status: 422 });
        const r = await run(toInput(f));
        if (r?.ok) {
          writeLocal(DRAFT_KEY, null);
          writeLocal(SUBMISSION_KEY, null);
          router.push(`/homeowner/jobs/${r.data.id}`);
        }
      }}
    >
      {restored ? <Notice>We&apos;ve restored the details you entered earlier.</Notice> : null}
      <ErrorSummary error={error} />
      <DetailsFields f={f} set={set} errors={error?.fields ?? {}} />
      <Button type="submit" busy={busy}>Save and add photos</Button>
    </form>
  );
}

export function EditDraftForm({ jobId, initial }: { jobId: string; initial: FormState }) {
  const [f, setF] = useState<FormState>(initial);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof FormState) => (e: { target: { value: string } }) => {
    setSaved(false);
    setF((s) => ({ ...s, [k]: e.target.value }));
  };
  const { run, busy, error, setError } = useSubmit(useCallback((_k: string, draft: unknown) => api(`/api/jobs/${jobId}`, { method: "PATCH", body: draft, retrySafe: true }), [jobId]));
  return (
    <details className="card">
      <summary><strong>Edit job details</strong></summary>
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const parsed = jobDraftSchema.safeParse(toInput(f));
          if (!parsed.success) return setError({ code: "VALIDATION_FAILED", message: "Some details need correcting.", fields: fieldsFromZod(parsed.error.issues), status: 422 });
          const r = await run(toInput(f));
          if (r?.ok) setSaved(true);
        }}
      >
        <ErrorSummary error={error} />
        {saved ? <Notice kind="success">Saved.</Notice> : null}
        <DetailsFields f={f} set={set} errors={error?.fields ?? {}} />
        <Button type="submit" busy={busy}>Save changes</Button>
      </form>
    </details>
  );
}

export type { FormState as JobFormState };

/** Step 2: uploads and consents, then submit for review. */
export function DraftUploads({ jobId, existing }: { jobId: string; existing: ExistingMedia[] }) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, { done: number; busy: boolean; failed: number }>>({});
  const [consents, setConsents] = useState({ accuracy: false, sharing: false, ownership: false, variation: false });
  const onState = useCallback((kind: string) => (s: { done: number; busy: boolean; failed: number }) => setState((prev) => ({ ...prev, [kind]: s })), []);
  const onQuote = useMemo(() => onState("quote_document"), [onState]);
  const onPhoto = useMemo(() => onState("photo"), [onState]);
  const onVideo = useMemo(() => onState("video"), [onState]);
  const { run, busy, error, setError } = useSubmit(
    useCallback((key: string) => api<{ status: string }>(`/api/jobs/${jobId}/submit`, { method: "POST", idempotencyKey: key, body: { consentAccuracy: true, consentSharing: true } }), [jobId]),
  );
  const anyBusy = Object.values(state).some((s) => s.busy);
  const quoteDone = (state.quote_document?.done ?? 0) > 0;
  const photosDone = (state.photo?.done ?? 0) > 0;

  return (
    <div className="stack">
      <MediaUploader jobId={jobId} kind="quote_document" label="Your quote" hint="PDF, JPG, PNG or WEBP, up to 15–20 MB. A clear photo of a paper quote is fine. Only our reviewers see the original." accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp" existing={existing} onStateChange={onQuote} />
      <MediaUploader jobId={jobId} kind="photo" label="Photos (at least 3 recommended)" hint="JPG, PNG or WEBP, up to 20 MB each. Location data is removed before builders see them." accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple existing={existing} onStateChange={onPhoto} />
      <MediaUploader jobId={jobId} kind="video" label="Video walkthrough (1 to 2 minutes)" hint="MP4, MOV or WEBM, up to 500 MB. Large videos upload in parts and resume if your connection drops. Avoid filming people, house numbers or number plates." accept=".mp4,.m4v,.mov,.webm,video/mp4,video/quicktime,video/webm" existing={existing} onStateChange={onVideo} />

      <form
        className="card"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const fields: Record<string, string> = {};
          if (!quoteDone) fields.quote = "Please upload your quote";
          if (!photosDone) fields.photos = "Please upload at least one photo";
          if (!consents.accuracy || !consents.sharing || !consents.ownership || !consents.variation) fields.consents = "Please confirm all the statements";
          if (anyBusy) fields.uploads = "Please wait for uploads to finish";
          if (Object.keys(fields).length) return setError({ code: "SUBMISSION_INCOMPLETE", message: "Your submission isn't complete yet.", fields, status: 422 } as ApiError);
          const r = await run();
          if (r?.ok) router.refresh();
        }}
      >
        <h2>Send for review</h2>
        <p className="badge">DRAFT WORDING FOR SOLICITOR REVIEW</p>
        <ErrorSummary error={error} />
        <Checkbox checked={consents.accuracy} onChange={(e) => setConsents((c) => ({ ...c, accuracy: e.target.checked }))} label="The quote and details I've given are accurate." />
        <Checkbox checked={consents.sharing} onChange={(e) => setConsents((c) => ({ ...c, sharing: e.target.checked }))} label="I agree that Beat My Quote may edit my quote to hide the original builder's details, write a standard scope from it, and share the scope, photos and video with vetted builders. My name, contact details and full address stay hidden until I accept an offer." />
        <Checkbox checked={consents.ownership} onChange={(e) => setConsents((c) => ({ ...c, ownership: e.target.checked }))} label="I own these photos and video or have permission to share them, and anyone shown in them has agreed." />
        <Checkbox checked={consents.variation} onChange={(e) => setConsents((c) => ({ ...c, variation: e.target.checked }))} label="I understand that any offer is based on my uploads and is confirmed by a short pre-start check. The price can only change through a written Variation Form for something not reasonably visible in my uploads, or for extra work I ask for, and if I decline such a change the contract ends and my deposit is refunded in full." />
        <Button type="submit" busy={busy} disabled={anyBusy}>Submit for review</Button>
      </form>
    </div>
  );
}
