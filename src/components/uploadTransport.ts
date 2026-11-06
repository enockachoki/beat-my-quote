"use client";

import { backoffDelayMs } from "@/lib/backoff";

export type UploadTarget =
  | { mode: "put"; url: string; headers: Record<string, string>; expiresAt: string }
  | { mode: "tus"; endpoint: string; headers: Record<string, string>; metadata: Record<string, string>; chunkSize: number; expiresAt: string };

export class UploadError extends Error {
  constructor(public readonly kind: "aborted" | "timeout" | "network" | "rejected" | "expired", message: string) {
    super(message);
  }
}

interface SendOpts { onProgress: (sentBytes: number) => void; signal: AbortSignal; timeoutMs: number }

/** XHR is used (not fetch) because it reports upload progress. */
function xhrSend(method: string, url: string, headers: Record<string, string>, body: Blob | null, o: SendOpts): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = o.timeoutMs;
    xhr.upload.onprogress = (e) => o.onProgress(e.loaded);
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(new UploadError("network", "Network error"));
    xhr.ontimeout = () => reject(new UploadError("timeout", "Timed out"));
    xhr.onabort = () => reject(new UploadError("aborted", "Cancelled"));
    if (o.signal.aborted) return reject(new UploadError("aborted", "Cancelled"));
    o.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

const timeoutFor = (bytes: number) => Math.max(60_000, Math.ceil(bytes / (64 * 1024)) * 1000); // assume >= 64 KB/s

/** Single-request upload for small files, with bounded retries. */
async function putUpload(file: File, t: Extract<UploadTarget, { mode: "put" }>, onProgress: (f: number) => void, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const xhr = await xhrSend("PUT", t.url, t.headers, file, { onProgress: (b) => onProgress(b / file.size), signal, timeoutMs: timeoutFor(file.size) });
      if (xhr.status >= 200 && xhr.status < 300) return;
      if (xhr.status === 403 || xhr.status === 400) throw new UploadError("expired", "Upload link expired");
      if (xhr.status === 413) throw new UploadError("rejected", "File too large");
      throw new UploadError("network", `HTTP ${xhr.status}`);
    } catch (err) {
      const e = err as UploadError;
      if (e.kind === "aborted" || e.kind === "expired" || e.kind === "rejected" || attempt >= 3) throw e;
      await sleep(backoffDelayMs(attempt, 1000, 8000) + 300, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); reject(new UploadError("aborted", "Cancelled")); }, { once: true });
  });
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const resumeKey = (fp: string) => `bmq.tus.${fp}`;

/**
 * Resumable upload (TUS 1.0). Chunks are sliced from the File (never read
 * whole into memory). After a dropped connection or page reload, the server
 * offset is read with HEAD and the upload continues from there.
 */
async function tusUpload(file: File, fingerprint: string, t: Extract<UploadTarget, { mode: "tus" }>, onProgress: (f: number) => void, signal: AbortSignal) {
  const base = { ...t.headers, "Tus-Resumable": "1.0.0" };
  let location: string | null = null;
  try {
    location = localStorage.getItem(resumeKey(fingerprint));
  } catch {
    location = null;
  }
  const readOffset = async (loc: string): Promise<number | null> => {
    const xhr = await xhrSend("HEAD", loc, base, null, { onProgress: () => {}, signal, timeoutMs: 15_000 });
    if (xhr.status !== 200 && xhr.status !== 204) return null;
    return Number(xhr.getResponseHeader("Upload-Offset") ?? "0");
  };
  let offset: number | null = location ? await readOffset(location).catch(() => null) : null;
  if (offset === null) {
    const metadata = Object.entries(t.metadata).map(([k, v]) => `${k} ${b64(v)}`).join(",");
    const xhr = await xhrSend("POST", t.endpoint, { ...base, "Upload-Length": String(file.size), "Upload-Metadata": metadata }, null, { onProgress: () => {}, signal, timeoutMs: 20_000 });
    if (xhr.status === 403 || xhr.status === 401) throw new UploadError("expired", "Upload link expired");
    if (xhr.status === 413) throw new UploadError("rejected", "File too large");
    if (xhr.status !== 201) throw new UploadError("network", `HTTP ${xhr.status}`);
    location = new URL(xhr.getResponseHeader("Location") ?? t.endpoint, t.endpoint).toString();
    try {
      localStorage.setItem(resumeKey(fingerprint), location);
    } catch {
      // storage unavailable: resume-after-reload just won't work
    }
    offset = 0;
  }
  let failures = 0;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + t.chunkSize));
    const start = offset;
    try {
      const xhr = await xhrSend("PATCH", location!, { ...base, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" }, chunk, {
        onProgress: (b) => onProgress((start + b) / file.size), signal, timeoutMs: timeoutFor(chunk.size),
      });
      if (xhr.status === 204) {
        offset = Number(xhr.getResponseHeader("Upload-Offset") ?? offset + chunk.size);
        failures = 0;
        onProgress(offset / file.size);
        continue;
      }
      if (xhr.status === 409) {
        offset = (await readOffset(location!)) ?? 0;
        continue;
      }
      if (xhr.status === 404 || xhr.status === 410 || xhr.status === 403) throw new UploadError("expired", "Upload expired");
      throw new UploadError("network", `HTTP ${xhr.status}`);
    } catch (err) {
      const e = err as UploadError;
      if (e.kind === "aborted" || e.kind === "expired" || ++failures > 5) throw e;
      await sleep(backoffDelayMs(failures, 1000, 15_000) + 500, signal);
      offset = (await readOffset(location!).catch(() => null)) ?? offset;
    }
  }
  try {
    localStorage.removeItem(resumeKey(fingerprint));
  } catch {
    // ignore
  }
}

export async function uploadFile(file: File, fingerprint: string, target: UploadTarget, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<void> {
  if (target.mode === "put") return putUpload(file, target, onProgress, signal);
  return tusUpload(file, fingerprint, target, onProgress, signal);
}
