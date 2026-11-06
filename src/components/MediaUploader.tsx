"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_UPLOAD_LIMITS, fileFingerprint, preCheckFile, type MediaKind } from "@/lib/fileTypes";
import { ERROR_MESSAGES, type ErrorCode } from "@/lib/errorCodes";
import { api } from "./api";
import { uploadFile, UploadError, type UploadTarget } from "./uploadTransport";
import { Button } from "./ui";

const noopSubscribe = () => () => {};

export interface ExistingMedia { id: string; kind: MediaKind; status: string; filename: string; sizeBytes: number; mime: string; hasThumbnail: boolean; errorCode: string | null }

type Status = "queued" | "uploading" | "verifying" | "done" | "error" | "cancelled" | "interrupted";
interface Item {
  localId: string;
  file?: File;
  fingerprint: string;
  name: string;
  size: number;
  mime: string;
  status: Status;
  progress: number;
  error?: string;
  mediaId?: string;
  previewUrl?: string;
  hasThumbnail?: boolean;
}

const MAX_PARALLEL = 2;

function fromExisting(m: ExistingMedia): Item {
  const done = ["uploaded", "processing", "ready"].includes(m.status);
  return {
    localId: m.id, mediaId: m.id, fingerprint: m.id, name: m.filename, size: m.sizeBytes, mime: m.mime, progress: done ? 1 : 0,
    status: done ? "done" : "interrupted", hasThumbnail: m.hasThumbnail,
    error: done ? undefined : "This upload didn't finish. Choose the same file again to resume it.",
  };
}

function friendly(code: ErrorCode | string): string {
  return (ERROR_MESSAGES as Record<string, string>)[code] ?? ERROR_MESSAGES.INTERNAL;
}

function formatSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function MediaUploader(props: {
  jobId: string;
  kind: MediaKind;
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  existing?: ExistingMedia[];
  onStateChange?: (s: { done: number; busy: boolean; failed: number }) => void;
}) {
  const [items, setItems] = useState<Item[]>(() => (props.existing ?? []).filter((m) => m.kind === props.kind && m.status !== "deleted" && m.status !== "rejected").map(fromExisting));
  const controllers = useRef(new Map<string, AbortController>());
  const running = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onStateChange } = props;

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Files picked before hydration would be lost, so the picker stays disabled until then.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const patch = useCallback((localId: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.localId === localId ? { ...i, ...p } : i))), []);

  useEffect(() => {
    onStateChange?.({
      done: items.filter((i) => i.status === "done").length,
      busy: items.some((i) => ["queued", "uploading", "verifying"].includes(i.status)),
      failed: items.filter((i) => i.status === "error" || i.status === "interrupted").length,
    });
  }, [items, onStateChange]);

  // Release preview object URLs.
  useEffect(() => () => items.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl)), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Warn before leaving mid-upload so work isn't lost by accident.
  useEffect(() => {
    const busy = items.some((i) => i.status === "uploading" || i.status === "verifying");
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [items]);

  const runUpload = useCallback(
    async (item: Item, target: UploadTarget, mediaId: string) => {
      const controller = new AbortController();
      controllers.current.set(item.localId, controller);
      running.current++;
      patch(item.localId, { status: "uploading", mediaId, progress: 0, error: undefined });
      try {
        await uploadFile(item.file!, item.fingerprint, target, (f) => patch(item.localId, { progress: Math.min(0.99, f) }), controller.signal);
        patch(item.localId, { status: "verifying", progress: 1 });
        const r = await api<{ status: string }>(`/api/media/${mediaId}/complete`, { method: "POST", retrySafe: true, timeoutMs: 60_000 });
        if (!r.ok) throw new UploadError("rejected", r.error.message);
        patch(item.localId, { status: "done", hasThumbnail: r.data.status === "ready" && item.mime.startsWith("image/") });
      } catch (err) {
        const e = err as UploadError;
        if (e.kind === "aborted") patch(item.localId, { status: "cancelled", error: "Upload cancelled." });
        else if (e.kind === "expired") patch(item.localId, { status: "error", error: ERROR_MESSAGES.UPLOAD_EXPIRED });
        else if (e.kind === "rejected") patch(item.localId, { status: "error", error: e.message });
        else patch(item.localId, { status: "error", error: "The upload was interrupted. Check your connection and press Retry." });
      } finally {
        controllers.current.delete(item.localId);
        running.current--;
      }
    },
    [patch],
  );

  const start = useCallback(
    async (batch: Item[]) => {
      if (batch.length === 0) return;
      const r = await api<{ results: Array<{ fingerprint: string; ok: boolean; code?: string; mediaId?: string; target?: UploadTarget | null; alreadyUploaded?: boolean }> }>(
        `/api/jobs/${props.jobId}/media/intents`,
        { method: "POST", body: { kind: props.kind, files: batch.map((i) => ({ name: i.name, size: i.size, type: i.mime, fingerprint: i.fingerprint })) }, retrySafe: true },
      );
      if (!r.ok) {
        batch.forEach((i) => patch(i.localId, { status: "error", error: r.error.message }));
        return;
      }
      const queue: Array<() => Promise<void>> = [];
      for (const item of batch) {
        const res = r.data.results.find((x) => x.fingerprint === item.fingerprint);
        if (!res || !res.ok) {
          patch(item.localId, { status: "error", error: friendly(res?.code ?? "INTERNAL") });
          continue;
        }
        if (res.alreadyUploaded || !res.target) {
          patch(item.localId, { status: "done", mediaId: res.mediaId, progress: 1 });
          continue;
        }
        queue.push(() => runUpload(item, res.target!, res.mediaId!));
      }
      // Limited parallelism keeps phones responsive on slow connections.
      const workers = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
        while (queue.length) await queue.shift()!();
      });
      await Promise.all(workers);
    },
    [patch, props.jobId, props.kind, runUpload],
  );

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const added: Item[] = [];
    const resumed: Item[] = [];
    {
      const next = [...itemsRef.current];
      for (const file of Array.from(files)) {
        const fingerprint = fileFingerprint(file);
        const check = preCheckFile(file, props.kind, DEFAULT_UPLOAD_LIMITS);
        // A previously interrupted upload of the same file resumes in place.
        const interrupted = next.find((i) => i.status === "interrupted" && i.name === file.name && i.size === file.size);
        if (interrupted) {
          const upd = { ...interrupted, file, fingerprint, status: "queued" as Status, error: undefined };
          next[next.indexOf(interrupted)] = upd;
          resumed.push(upd);
          continue;
        }
        if (next.some((i) => i.fingerprint === fingerprint && i.status !== "cancelled" && i.status !== "error")) continue; // duplicate pick
        const item: Item = {
          localId: crypto.randomUUID(), file, fingerprint, name: file.name, size: file.size, mime: file.type,
          status: check.ok ? "queued" : "error", progress: 0, error: check.ok ? undefined : friendly(check.code),
          previewUrl: check.ok && file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
        };
        next.push(item);
        if (check.ok) added.push(item);
      }
      itemsRef.current = next;
      setItems(next);
    }
    void start([...added, ...resumed]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const cancel = (i: Item) => controllers.current.get(i.localId)?.abort();
  const retry = (i: Item) => {
    if (!i.file) {
      inputRef.current?.click();
      return;
    }
    patch(i.localId, { status: "queued", error: undefined, progress: 0 });
    void start([{ ...i, status: "queued" }]);
  };
  const remove = async (i: Item) => {
    cancel(i);
    if (i.mediaId) {
      const r = await api(`/api/media/${i.mediaId}`, { method: "DELETE", retrySafe: true });
      if (!r.ok && r.error.code !== "NOT_FOUND") {
        patch(i.localId, { error: r.error.message });
        return;
      }
    }
    if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
    setItems((list) => list.filter((x) => x.localId !== i.localId));
  };

  return (
    <div className="uploader" data-testid={`uploader-${props.kind}`} data-ready={hydrated ? "true" : "false"}>
      <div className="uploader-head">
        <div>
          <strong>{props.label}</strong>
          <p className="hint">{props.hint}</p>
        </div>
        <label className="btn btn-secondary">
          <input ref={inputRef} type="file" disabled={!hydrated} className="visually-hidden" accept={props.accept} multiple={props.multiple} onChange={(e) => addFiles(e.target.files)} data-testid={`file-${props.kind}`} />
          <span>Add files</span>
        </label>
      </div>
      {items.length > 0 ? (
        <ul className="upload-list" aria-live="polite">
          {items.map((i) => (
            <li key={i.localId} className={`upload-item upload-${i.status}`} data-testid="upload-item" data-status={i.status}>
              <div className="upload-preview" aria-hidden="true">
                {i.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={i.previewUrl} alt="" />
                ) : i.hasThumbnail && i.mediaId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/${i.mediaId}/view?variant=thumb`} alt="" />
                ) : (
                  <span className="file-badge">{i.mime.split("/")[1]?.toUpperCase().slice(0, 4) ?? "FILE"}</span>
                )}
              </div>
              <div className="upload-body">
                <div className="upload-name">{i.name} <span className="small">({formatSize(i.size)})</span></div>
                {i.status === "uploading" || i.status === "verifying" ? (
                  <progress max={1} value={i.progress} aria-label={`Uploading ${i.name}`}>{Math.round(i.progress * 100)}%</progress>
                ) : null}
                <div className="small" role={i.status === "error" ? "alert" : undefined}>
                  {i.status === "queued" && "Waiting to upload"}
                  {i.status === "uploading" && `Uploading ${Math.round(i.progress * 100)}%`}
                  {i.status === "verifying" && "Checking file"}
                  {i.status === "done" && "Uploaded"}
                  {(i.status === "error" || i.status === "cancelled" || i.status === "interrupted") && i.error}
                </div>
              </div>
              <div className="upload-actions">
                {i.status === "uploading" ? <Button type="button" variant="secondary" onClick={() => cancel(i)}>Cancel</Button> : null}
                {i.status === "error" || i.status === "cancelled" || i.status === "interrupted" ? <Button type="button" variant="secondary" onClick={() => retry(i)}>{i.file ? "Retry" : "Choose file"}</Button> : null}
                {i.status !== "uploading" && i.status !== "verifying" ? <Button type="button" variant="secondary" onClick={() => void remove(i)} aria-label={`Remove ${i.name}`}>Remove</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
