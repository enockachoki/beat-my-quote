import "server-only";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { signToken } from "./signing";
import { RESUMABLE_THRESHOLD_BYTES, TUS_CHUNK_BYTES, type StorageProvider, type UploadTarget } from "./types";

/**
 * Local filesystem storage for development and automated tests only. It
 * emulates Supabase's signed upload, TUS resumable upload and signed read URLs
 * through /api/dev-storage/*, with HMAC-signed expiring tokens.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = "local";
  constructor(private readonly root: string, private readonly secret: string, private readonly origin: string) {}

  resolve(p: string): string {
    const full = path.resolve(this.root, p);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("path escapes storage root");
    return full;
  }

  async createUploadTarget(p: string, opts: { contentType: string; sizeBytes: number; expiresInSeconds: number }): Promise<UploadTarget> {
    const exp = Math.floor(Date.now() / 1000) + opts.expiresInSeconds;
    const expiresAt = new Date(exp * 1000).toISOString();
    if (opts.sizeBytes > RESUMABLE_THRESHOLD_BYTES) {
      const token = signToken(this.secret, { p, op: "tus", exp, max: opts.sizeBytes, ct: opts.contentType });
      return { mode: "tus", endpoint: `${this.origin}/api/dev-storage/tus/${token}`, headers: {}, metadata: { contentType: opts.contentType }, chunkSize: TUS_CHUNK_BYTES, expiresAt };
    }
    const token = signToken(this.secret, { p, op: "put", exp, max: opts.sizeBytes, ct: opts.contentType });
    return { mode: "put", url: `${this.origin}/api/dev-storage/upload/${token}`, headers: { "content-type": opts.contentType }, expiresAt };
  }

  async head(p: string, bytes: number) {
    const full = this.resolve(p);
    try {
      const s = await stat(full);
      const fh = await open(full, "r");
      try {
        const buf = Buffer.alloc(Math.min(bytes, s.size));
        await fh.read(buf, 0, buf.length, 0);
        return { head: new Uint8Array(buf), size: s.size };
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  async stream(p: string): Promise<Readable> {
    return createReadStream(this.resolve(p));
  }

  async put(p: string, body: Buffer): Promise<void> {
    const full = this.resolve(p);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  async signedReadUrl(p: string, ttlSeconds: number): Promise<string> {
    const token = signToken(this.secret, { p, op: "get", exp: Math.floor(Date.now() / 1000) + ttlSeconds });
    return `${this.origin}/api/dev-storage/object/${token}`;
  }

  async remove(paths: string[]): Promise<void> {
    await Promise.all(paths.flatMap((p) => [rm(this.resolve(p), { force: true }), rm(this.resolve(p) + ".part", { force: true })]));
  }
}
