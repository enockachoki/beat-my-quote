import "server-only";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { config } from "../config";
import { withServiceTx, withUserTx } from "../db/client";
import * as jobsRepo from "../db/repositories/jobs";
import * as mediaRepo from "../db/repositories/media";
import { AppError } from "../errors";
import { assertCanUploadKind, assertMediaEditable, assertOwnsJob, requireRole, type SessionUser } from "../authz/policies";
import { sameFamily, sniffMime } from "../domain/fileSniff";
import { ALLOWED_MIME, DEFAULT_UPLOAD_LIMITS, KIND_ALLOWED_CATEGORIES, extensionOf, preCheckFile, sanitiseFilename, type MediaKind } from "@/lib/fileTypes";
import { storage } from "../storage";
import type { UploadTarget } from "../storage/types";
import type { MediaRow } from "../db/types";
import { log } from "../observability/logger";
import { scan } from "./scanner";
import { audit } from "./audit";

export type IntentResult =
  | { fingerprint: string; ok: true; mediaId: string; target: UploadTarget | null; alreadyUploaded: boolean }
  | { fingerprint: string; ok: false; code: "UPLOAD_INVALID_TYPE" | "UPLOAD_TOO_LARGE" | "UPLOAD_TOO_MANY" };

/**
 * Step 1 of the upload pipeline: validate metadata, reserve a media row
 * (idempotent per file fingerprint) and hand back a short-lived, path-scoped
 * upload target. Bytes go straight to storage, never through our servers.
 */
export async function createIntents(user: SessionUser, jobId: string, kind: MediaKind, files: Array<{ name: string; size: number; type: string; fingerprint: string }>): Promise<IntentResult[]> {
  requireRole(user, "homeowner", "admin");
  assertCanUploadKind(user, kind);
  const cfg = config();
  const limits = DEFAULT_UPLOAD_LIMITS;
  const reserved = await withServiceTx(async (tx) => {
    const job = await jobsRepo.getJob(tx, jobId, { forUpdate: true }); // serialises concurrent intents for the count check
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    assertMediaEditable(user, job.status);
    const counts = await mediaRepo.countActive(tx, jobId);
    let total = counts.total;
    let videos = counts.videos;
    const out: Array<{ fingerprint: string; ok: false; code: "UPLOAD_INVALID_TYPE" | "UPLOAD_TOO_LARGE" | "UPLOAD_TOO_MANY" } | { fingerprint: string; ok: true; row: MediaRow; created: boolean }> = [];
    for (const f of files) {
      const check = preCheckFile(f, kind, limits);
      if (!check.ok) {
        out.push({ fingerprint: f.fingerprint, ok: false, code: check.code });
        continue;
      }
      const ext = extensionOf(f.name);
      const { row, created } = await mediaRepo.insertPending(tx, {
        jobId, uploadedBy: user.id, kind, clientFingerprint: f.fingerprint, originalFilename: sanitiseFilename(f.name),
        declaredMime: check.mime, sizeBytes: f.size,
        // Storage paths never contain user-supplied names.
        storagePath: `jobs/${jobId}/${randomUUID()}.${ext}`,
        uploadExpiresAt: new Date(Date.now() + cfg.UPLOAD_URL_TTL_SECONDS * 1000),
      });
      if (created) {
        const isVideo = check.category === "video";
        if (kind !== "quote_redacted" && (total + 1 > limits.maxFilesPerJob || (isVideo && videos + 1 > limits.maxVideosPerJob))) {
          await mediaRepo.update(tx, row.id, { status: "rejected", error_code: "UPLOAD_TOO_MANY" });
          out.push({ fingerprint: f.fingerprint, ok: false, code: "UPLOAD_TOO_MANY" });
          continue;
        }
        total++;
        if (isVideo) videos++;
      } else if (row.status === "pending_upload") {
        // Retry of an interrupted upload: extend the reservation.
        await mediaRepo.update(tx, row.id, { upload_expires_at: new Date(Date.now() + cfg.UPLOAD_URL_TTL_SECONDS * 1000) });
      }
      out.push({ fingerprint: f.fingerprint, ok: true, row, created });
    }
    return out;
  });

  const results: IntentResult[] = [];
  for (const r of reserved) {
    if (!r.ok) {
      results.push(r);
      continue;
    }
    if (r.row.status !== "pending_upload") {
      results.push({ fingerprint: r.fingerprint, ok: true, mediaId: r.row.id, target: null, alreadyUploaded: true });
      continue;
    }
    const target = await storage().createUploadTarget(r.row.storagePath, { contentType: r.row.declaredMime, sizeBytes: Number(r.row.sizeBytes), expiresInSeconds: cfg.UPLOAD_URL_TTL_SECONDS });
    results.push({ fingerprint: r.fingerprint, ok: true, mediaId: r.row.id, target, alreadyUploaded: false });
  }
  return results;
}

async function loadEditable(user: SessionUser, mediaId: string) {
  return withServiceTx(async (tx) => {
    const m = await mediaRepo.getMedia(tx, mediaId);
    if (!m) throw new AppError("NOT_FOUND");
    const job = await jobsRepo.getJob(tx, m.jobId);
    if (!job) throw new AppError("NOT_FOUND");
    assertOwnsJob(user, job);
    if (user.role !== "admin" && m.uploadedBy !== user.id) throw new AppError("NOT_FOUND");
    return { m, job };
  });
}

/**
 * Step 2: the browser says the upload finished. We verify the object really
 * exists, its size matches, and its first bytes match an allowed type for this
 * media kind, whatever the filename or browser said.
 */
export async function completeUpload(user: SessionUser, mediaId: string) {
  requireRole(user, "homeowner", "admin");
  const { m } = await loadEditable(user, mediaId);
  if (m.status !== "pending_upload") return { id: m.id, status: m.status };
  if (m.uploadExpiresAt.getTime() < Date.now() - 5 * 60_000) {
    await withServiceTx((tx) => mediaRepo.update(tx, m.id, { status: "rejected", error_code: "UPLOAD_EXPIRED" }));
    await storage().remove([m.storagePath]).catch(() => {});
    throw new AppError("UPLOAD_EXPIRED");
  }
  const head = await storage().head(m.storagePath, 64);
  if (!head) throw new AppError("UPLOAD_INCOMPLETE");
  if (head.size !== Number(m.sizeBytes)) {
    log.warn("upload.size_mismatch", { mediaId: m.id, expected: Number(m.sizeBytes), got: head.size });
    throw new AppError("UPLOAD_INCOMPLETE");
  }
  const detected = sniffMime(head.head);
  const declared = m.declaredMime as Parameters<typeof sameFamily>[0];
  const kindOk = detected !== null && KIND_ALLOWED_CATEGORIES[m.kind].includes(ALLOWED_MIME[detected].category);
  if (!detected || !sameFamily(declared, detected) || !kindOk) {
    log.warn("upload.content_mismatch", { mediaId: m.id, declared: m.declaredMime, detected });
    await withServiceTx(async (tx) => {
      await mediaRepo.update(tx, m.id, { status: "rejected", error_code: "UPLOAD_CONTENT_MISMATCH", detected_mime: detected });
      await audit(tx, user, "media.quarantined", "media", m.id, { reason: "content_mismatch", declared: m.declaredMime, detected });
    });
    await storage().remove([m.storagePath]).catch(() => {});
    throw new AppError("UPLOAD_CONTENT_MISMATCH");
  }
  const updated = await withServiceTx((tx) => mediaRepo.update(tx, m.id, { status: "uploaded", detected_mime: detected }));
  // Images and PDFs (small) are processed inline; videos go to the background
  // worker so large files are never handled inside a user request.
  if (!detected.startsWith("video/")) {
    await processOne(updated!).catch((err) => log.warn("media.inline_process_failed", { mediaId: m.id, err }));
  }
  const fresh = await withServiceTx((tx) => mediaRepo.getMedia(tx, m.id));
  return { id: m.id, status: fresh!.status };
}

export async function removeMedia(user: SessionUser, mediaId: string) {
  requireRole(user, "homeowner", "admin");
  const { m, job } = await loadEditable(user, mediaId);
  assertMediaEditable(user, job.status);
  await withServiceTx(async (tx) => {
    await mediaRepo.update(tx, m.id, { status: "deleted", visible_to_builders: false });
    await audit(tx, user, "media.removed", "media", m.id, { jobId: job.id });
  });
  const paths = [m.storagePath, m.processedPath, m.thumbnailPath].filter((p): p is string => !!p);
  await storage().remove(paths).catch((err) => log.warn("media.remove_storage_failed", { mediaId: m.id, err }));
}

async function sha256OfStream(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = await storage().stream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function readAll(path: string, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await storage().stream(path)) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw Object.assign(new Error("too large to buffer"), { code: "TOO_LARGE" });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Step 3 (background): scan, strip metadata (incl. GPS EXIF) by re-encoding
 * images, and make thumbnails. Videos and PDFs are streamed, never buffered.
 */
export async function processOne(m: MediaRow): Promise<void> {
  const verdict = await scan(await storage().stream(m.storagePath), m.originalFilename);
  if (verdict === "infected") {
    await withServiceTx(async (tx) => {
      await mediaRepo.update(tx, m.id, { status: "quarantined", scan_status: "infected", visible_to_builders: false, error_code: "MALWARE" });
      await audit(tx, { id: null, role: "system" }, "media.quarantined", "media", m.id, { reason: "malware" });
    });
    log.error("media.malware_detected", { mediaId: m.id, jobId: m.jobId });
    return;
  }
  const mime = m.detectedMime ?? m.declaredMime;
  if (mime.startsWith("image/")) {
    const input = await readAll(m.storagePath, DEFAULT_UPLOAD_LIMITS.maxImageBytes + 1);
    const sha = createHash("sha256").update(input).digest("hex");
    let processed: Buffer;
    let thumb: Buffer;
    try {
      const base = sharp(input, { failOn: "error", limitInputPixels: 100_000_000 }).rotate(); // apply orientation, then metadata is dropped
      processed = await (mime === "image/png" ? base.png() : mime === "image/webp" ? base.webp({ quality: 85 }) : base.jpeg({ quality: 85, mozjpeg: true })).toBuffer();
      thumb = await sharp(processed).resize(480, 480, { fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
    } catch (err) {
      await withServiceTx((tx) => mediaRepo.update(tx, m.id, { status: "rejected", error_code: "IMAGE_UNREADABLE" }));
      log.warn("media.image_unreadable", { mediaId: m.id, err });
      return;
    }
    const processedPath = m.storagePath.replace(/\.[a-z0-9]+$/, `.clean.${mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"}`);
    const thumbPath = m.storagePath.replace(/\.[a-z0-9]+$/, ".thumb.webp");
    await storage().put(processedPath, processed, mime);
    await storage().put(thumbPath, thumb, "image/webp");
    await withServiceTx((tx) => mediaRepo.update(tx, m.id, {
      status: "ready", scan_status: verdict, sha256: sha, processed_path: processedPath, thumbnail_path: thumbPath, metadata_stripped: true, error_code: null,
    }));
    return;
  }
  // PDF and video: hash by streaming. Video metadata stripping and thumbnails need a
  // transcoding worker (e.g. ffmpeg or Cloudflare Stream): documented limitation.
  const sha = await sha256OfStream(m.storagePath);
  await withServiceTx((tx) => mediaRepo.update(tx, m.id, { status: "ready", scan_status: verdict, sha256: sha, metadata_stripped: false, error_code: null }));
}

export async function processPending(limit = 10): Promise<number> {
  const batch = await withServiceTx((tx) => mediaRepo.claimForProcessing(tx, limit));
  for (const m of batch) {
    await processOne(m).catch(async (err) => {
      log.error("media.process_failed", { mediaId: m.id, attempts: m.attempts, err });
      await withServiceTx((tx) => mediaRepo.update(tx, m.id, m.attempts >= 5 ? { status: "rejected", error_code: "PROCESSING_FAILED" } : { status: "uploaded" })).catch(() => {});
    });
  }
  return batch.length;
}

/** Removes reservations whose upload never completed, and their partial objects. */
export async function cleanupStaleUploads(limit = 100): Promise<number> {
  const stale = await withServiceTx(async (tx) => {
    const rows = await mediaRepo.staleUploads(tx, limit);
    for (const r of rows) await mediaRepo.update(tx, r.id, { status: "deleted", error_code: "ABANDONED" });
    return rows;
  });
  if (stale.length) await storage().remove(stale.map((r) => r.storagePath)).catch((err) => log.warn("media.cleanup_storage_failed", { err }));
  return stale.length;
}

/**
 * Short-lived signed URL for viewing. Builders only ever get processed
 * (metadata-stripped) copies of media an admin published, read under RLS.
 */
export async function signedViewUrl(user: SessionUser, mediaId: string, variant: "thumb" | "full"): Promise<string> {
  const ttl = config().SIGNED_URL_TTL_SECONDS;
  let m: MediaRow | null;
  if (user.role === "builder") {
    m = await withUserTx(user, (tx) => mediaRepo.getMedia(tx, mediaId)); // RLS decides
    if (!m || !m.visibleToBuilders || m.kind === "quote_document" || m.status !== "ready") throw new AppError("NOT_FOUND");
  } else {
    m = await withServiceTx(async (tx) => {
      const row = await mediaRepo.getMedia(tx, mediaId);
      if (!row) return null;
      const job = await jobsRepo.getJob(tx, row.jobId);
      if (!job) return null;
      assertOwnsJob(user, job);
      if (user.role === "admin" && row.kind === "quote_document") await audit(tx, user, "media.original_viewed", "media", row.id, { jobId: job.id });
      return row;
    });
    if (!m || m.status === "deleted" || m.status === "quarantined") throw new AppError("NOT_FOUND");
  }
  const mime = m.detectedMime ?? m.declaredMime;
  let path: string | null;
  if (variant === "thumb") path = m.thumbnailPath;
  else if (mime.startsWith("image/")) path = user.role === "admin" ? m.processedPath ?? m.storagePath : m.processedPath;
  else path = m.storagePath;
  if (!path) throw new AppError("NOT_FOUND", { internal: "variant not available" });
  return storage().signedReadUrl(path, ttl);
}
