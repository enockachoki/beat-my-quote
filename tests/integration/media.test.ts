import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import sharp from "sharp";
import * as jobService from "@/server/services/jobService";
import * as media from "@/server/services/mediaService";
import { storage } from "@/server/storage";
import { closeDb } from "@/server/db/client";
import { approvedJob, codeOf, draft, makeUser, readyMedia, sql } from "./helpers";

beforeAll(async () => {
  await rm(".dev-storage/integration", { recursive: true, force: true });
});
afterAll(async () => {
  await closeDb();
});

const file = (name: string, size: number, type: string) => ({ name, size, type, fingerprint: `${name}:${size}:1` });

async function setup() {
  const h = await makeUser("homeowner");
  const { job } = await jobService.createDraft(h, draft(), `key-media-${Math.random().toString(36).slice(2)}`);
  return { h, job };
}

async function gpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "#c0ffee" } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 28/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 4/1 0/1" } })
    .toBuffer();
}

describe("upload intents", () => {
  it("validates type, size and kind before issuing upload URLs", async () => {
    const { h, job } = await setup();
    const res = await media.createIntents(h, job.id, "photo", [
      file("ok.jpg", 1000, "image/jpeg"),
      file("bad.exe", 1000, "application/x-msdownload"),
      file("huge.jpg", 50 * 1024 * 1024, "image/jpeg"),
      file("doc.pdf", 1000, "application/pdf"),
    ]);
    expect(res.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ok", "UPLOAD_INVALID_TYPE", "UPLOAD_TOO_LARGE", "UPLOAD_INVALID_TYPE"]);
    const ok = res[0]!;
    expect(ok.ok && ok.target?.mode).toBe("put");
  });
  it("large videos get a resumable (TUS) target", async () => {
    const { h, job } = await setup();
    const [r] = await media.createIntents(h, job.id, "video", [file("walk.mp4", 200 * 1024 * 1024, "video/mp4")]);
    expect(r!.ok && r!.target?.mode).toBe("tus");
  });
  it("the same file picked twice reuses one reservation (no duplicate uploads)", async () => {
    const { h, job } = await setup();
    const [a] = await media.createIntents(h, job.id, "photo", [file("dup.jpg", 1234, "image/jpeg")]);
    const [b] = await media.createIntents(h, job.id, "photo", [file("dup.jpg", 1234, "image/jpeg")]);
    expect(a!.ok && b!.ok && a!.mediaId === b!.mediaId).toBe(true);
  });
  it("enforces the per-job file count", async () => {
    const { h, job } = await setup();
    const files = Array.from({ length: 30 }, (_, i) => file(`p${i}.jpg`, 1000 + i, "image/jpeg"));
    await media.createIntents(h, job.id, "photo", files);
    const [extra] = await media.createIntents(h, job.id, "photo", [file("one-too-many.jpg", 999, "image/jpeg")]);
    expect(extra!.ok ? "ok" : extra!.code).toBe("UPLOAD_TOO_MANY");
  });
  it("other users, builders and homeowners uploading redacted quotes are refused", async () => {
    const { h, job } = await setup();
    expect(await codeOf(media.createIntents(await makeUser("homeowner"), job.id, "photo", [file("x.jpg", 10, "image/jpeg")]))).toBe("NOT_FOUND");
    expect(await codeOf(media.createIntents(await makeUser("builder", { kind: "crew" }), job.id, "photo", [file("x.jpg", 10, "image/jpeg")]))).toBe("FORBIDDEN");
    expect(await codeOf(media.createIntents(h, job.id, "quote_redacted", [file("x.pdf", 10, "application/pdf")]))).toBe("FORBIDDEN");
  });
});

describe("upload completion and processing", () => {
  it("strips GPS/EXIF metadata, makes a thumbnail and marks the image ready", async () => {
    const { h, job } = await setup();
    const jpeg = await gpsJpeg();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const [r] = await media.createIntents(h, job.id, "photo", [file("site.jpg", jpeg.length, "image/jpeg")]);
    if (!r!.ok) throw new Error("intent failed");
    const [row] = await sql<{ storagePath: string }[]>`select storage_path from public.media where id = ${r!.mediaId}`;
    await storage().put(row!.storagePath, jpeg, "image/jpeg"); // simulates the browser's direct upload
    expect((await media.completeUpload(h, r!.mediaId)).status).toBe("ready");
    const [done] = await sql<{ processedPath: string; thumbnailPath: string; metadataStripped: boolean; sha256: string }[]>`select processed_path, thumbnail_path, metadata_stripped, sha256 from public.media where id = ${r!.mediaId}`;
    expect(done!.metadataStripped).toBe(true);
    expect(done!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const cleanHead = await storage().head(done!.processedPath, 1);
    expect(cleanHead).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of await storage().stream(done!.processedPath)) chunks.push(c as Buffer);
    const meta = await sharp(Buffer.concat(chunks)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(await storage().head(done!.thumbnailPath, 1)).not.toBeNull();
  });
  it("rejects files whose bytes don't match their claimed type, and deletes them", async () => {
    const { h, job } = await setup();
    const fakeJpeg = Buffer.from("<html><script>alert('x')</script></html>".padEnd(200, " "));
    const [r] = await media.createIntents(h, job.id, "photo", [file("evil.jpg", fakeJpeg.length, "image/jpeg")]);
    if (!r!.ok) throw new Error("intent failed");
    const [row] = await sql<{ storagePath: string }[]>`select storage_path from public.media where id = ${r!.mediaId}`;
    await storage().put(row!.storagePath, fakeJpeg, "image/jpeg");
    expect(await codeOf(media.completeUpload(h, r!.mediaId))).toBe("UPLOAD_CONTENT_MISMATCH");
    expect(await storage().head(row!.storagePath, 1)).toBeNull();
    const [after] = await sql<{ status: string }[]>`select status from public.media where id = ${r!.mediaId}`;
    expect(after!.status).toBe("rejected");
  });
  it("a missing or partial upload is reported as incomplete and can be retried", async () => {
    const { h, job } = await setup();
    const jpeg = await gpsJpeg();
    const [r] = await media.createIntents(h, job.id, "photo", [file("partial.jpg", jpeg.length, "image/jpeg")]);
    if (!r!.ok) throw new Error("intent failed");
    expect(await codeOf(media.completeUpload(h, r!.mediaId))).toBe("UPLOAD_INCOMPLETE");
    const [row] = await sql<{ storagePath: string }[]>`select storage_path from public.media where id = ${r!.mediaId}`;
    await storage().put(row!.storagePath, jpeg.subarray(0, 50), "image/jpeg");
    expect(await codeOf(media.completeUpload(h, r!.mediaId))).toBe("UPLOAD_INCOMPLETE");
    await storage().put(row!.storagePath, jpeg, "image/jpeg");
    expect((await media.completeUpload(h, r!.mediaId)).status).toBe("ready");
  });
  it("abandoned reservations are cleaned up", async () => {
    const { h, job } = await setup();
    const [r] = await media.createIntents(h, job.id, "photo", [file("abandoned.jpg", 500, "image/jpeg")]);
    if (!r!.ok) throw new Error("intent failed");
    await sql`update public.media set upload_expires_at = now() - interval '2 hours' where id = ${r!.mediaId}`;
    expect(await media.cleanupStaleUploads()).toBeGreaterThanOrEqual(1);
    const [row] = await sql<{ status: string }[]>`select status from public.media where id = ${r!.mediaId}`;
    expect(row!.status).toBe("deleted");
  });
});

describe("viewing media", () => {
  it("builders only get signed URLs for published, processed media, never the original quote", async () => {
    const { job, photo, homeowner } = await approvedJob();
    const crew = await makeUser("builder", { kind: "crew" });
    const outsider = await makeUser("builder", { kind: "crew", districts: ["N1"] });
    const [orig] = await sql<{ id: string }[]>`select id from public.media where job_id = ${job.id} and kind = 'quote_document'`;
    const unpublished = await readyMedia(job.id, homeowner.id, "photo");
    expect(await media.signedViewUrl(crew, photo, "full")).toContain("/api/dev-storage/object/");
    expect(await codeOf(media.signedViewUrl(crew, orig!.id, "full"))).toBe("NOT_FOUND");
    expect(await codeOf(media.signedViewUrl(crew, unpublished, "full"))).toBe("NOT_FOUND");
    expect(await codeOf(media.signedViewUrl(outsider, photo, "full"))).toBe("NOT_FOUND");
    expect(await codeOf(media.signedViewUrl(await makeUser("homeowner"), photo, "full"))).toBe("NOT_FOUND");
  });
  it("admin viewing of an original quote is audited", async () => {
    const { job, admin } = await approvedJob();
    const [orig] = await sql<{ id: string }[]>`select id from public.media where job_id = ${job.id} and kind = 'quote_document'`;
    await media.signedViewUrl(admin, orig!.id, "full");
    const rows = await sql`select * from public.audit_log where action = 'media.original_viewed' and entity_id = ${orig!.id}`;
    expect(rows.length).toBe(1);
  });
});
