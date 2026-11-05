"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatGBP } from "@/lib/money";
import { api } from "../api";
import { useSubmit } from "../useSubmit";
import { Button, Checkbox, ErrorSummary, Select, TextArea, TextInput } from "../ui";
import { MediaUploader, type ExistingMedia } from "../MediaUploader";

interface MediaView { id: string; kind: string; status: string; scanStatus: string; filename: string; mime: string; hasThumbnail: boolean; metadataStripped: boolean; visibleToBuilders: boolean }

function beatPrice(quotePence: number, bps: number) {
  return Math.floor(Math.floor((quotePence * (10000 - bps)) / 10000) / 100) * 100;
}

export function ReviewDecisionForm({ jobId, version, quotePence, media, minimumPence }: { jobId: string; version: number; quotePence: number; media: MediaView[]; minimumPence: number }) {
  const router = useRouter();
  const [scope, setScope] = useState("");
  const [bps, setBps] = useState(800);
  const [publish, setPublish] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const publishable = media.filter((m) => m.kind !== "quote_document" && m.status === "ready" && m.scanStatus !== "infected");
  const price = useMemo(() => beatPrice(quotePence, bps), [quotePence, bps]);
  const { run, busy, error } = useSubmit(useCallback((key: string, body: unknown) => api(`/api/admin/jobs/${jobId}/decision`, { method: "POST", idempotencyKey: key, body }), [jobId]));
  const existing: ExistingMedia[] = media.filter((m) => m.kind === "quote_redacted").map((m) => ({ id: m.id, kind: "quote_redacted", status: m.status, filename: m.filename, sizeBytes: 0, mime: m.mime, hasThumbnail: m.hasThumbnail, errorCode: null }));

  return (
    <div className="stack">
      <div className="card">
        <h2>1. Upload a redacted copy of the quote</h2>
        <p className="small">Remove the rival builder&apos;s name, logo, contact details, reference numbers and the homeowner&apos;s address. The original is never shown to builders.</p>
        <MediaUploader jobId={jobId} kind="quote_redacted" label="Redacted quote" hint="PDF or image" accept=".pdf,.jpg,.jpeg,.png,.webp" existing={existing} />
        <Button variant="secondary" type="button" onClick={() => router.refresh()}>Refresh media list</Button>
      </div>
      <form className="card" noValidate onSubmit={async (e) => {
        e.preventDefault();
        const r = await run({ decision: "approve", standardScope: scope, beatBasisPoints: bps, publishMediaIds: publish, expectedVersion: version });
        if (r?.ok) router.refresh();
      }}>
        <h2>2. Approve and send to crews</h2>
        <ErrorSummary error={error} />
        <TextArea label="Standard scope (shown to builders)" value={scope} onChange={(e) => setScope(e.target.value)} maxLength={8000} hint="Plain description of the work. No names, addresses or rival details." />
        <Select label="Beat percentage" value={String(bps)} onChange={(e) => setBps(Number(e.target.value))}>
          {[500, 600, 700, 800, 900, 1000].map((b) => <option key={b} value={b}>{b / 100}% below the quote</option>)}
        </Select>
        <p>Beat price: <strong className="price" data-testid="beat-price">{formatGBP(price)}</strong> <span className="small">(quote {formatGBP(quotePence)}, minimum {formatGBP(minimumPence)})</span></p>
        <fieldset className="field">
          <legend><strong>Media to publish to builders</strong></legend>
          {publishable.length === 0 ? <p className="small">Nothing is ready to publish yet. Images are ready once metadata has been stripped.</p> : null}
          {publishable.map((m) => (
            <Checkbox key={m.id} checked={publish.includes(m.id)} onChange={(e) => setPublish((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))}
              label={<>{m.kind === "quote_redacted" ? "Redacted quote" : m.kind}: {m.filename} {m.scanStatus === "not_scanned" ? <span className="badge">not malware-scanned: check manually</span> : null} {m.kind === "video" ? <span className="badge">video metadata not stripped</span> : null}</>} />
          ))}
        </fieldset>
        <Button type="submit" busy={busy} data-testid="approve-job">Approve job</Button>
      </form>
      <form className="card" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (!window.confirm("Reject this job? The homeowner will be told.")) return;
        const r = await run({ decision: "reject", reason, expectedVersion: version });
        if (r?.ok) router.refresh();
      }}>
        <h2>Or reject</h2>
        <TextInput label="Reason (sent to the homeowner)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        <Button type="submit" variant="danger" busy={busy}>Reject job</Button>
      </form>
    </div>
  );
}

export function BuilderDecisionForm({ builderId }: { builderId: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<"crew" | "partner">("partner");
  const [reason, setReason] = useState("");
  const { run, busy, error } = useSubmit(useCallback((key: string, body: unknown) => api(`/api/admin/builders/${builderId}/decision`, { method: "POST", idempotencyKey: key, body }), [builderId]));
  return (
    <div className="stack">
      <ErrorSummary error={error} />
      <div className="row">
        <Select label="Approve as" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="partner">Partner builder</option>
          <option value="crew">In-house crew (first refusal)</option>
        </Select>
        <Button busy={busy} data-testid={`approve-builder-${builderId}`} onClick={async () => { const r = await run({ decision: "approve", kind }); if (r?.ok) router.refresh(); }}>Approve</Button>
      </div>
      <div className="row">
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <Button variant="danger" busy={busy} onClick={async () => { const r = await run({ decision: "reject", reason }); if (r?.ok) router.refresh(); }}>Reject</Button>
      </div>
    </div>
  );
}
