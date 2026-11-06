import "server-only";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { RESUMABLE_THRESHOLD_BYTES, TUS_CHUNK_BYTES, type StorageProvider, type UploadTarget } from "./types";
import { withTimeout } from "../domain/resilience";

/**
 * Supabase Storage (private bucket). Uses the service-role key ON THE SERVER
 * ONLY to mint signed URLs; browsers receive only path-scoped signed tokens.
 * Status: implemented, not yet verified against a live project.
 */
export class SupabaseStorageProvider implements StorageProvider {
  readonly name = "supabase";
  private readonly client: SupabaseClient;

  constructor(private readonly url: string, serviceKey: string, private readonly anonKey: string, private readonly bucket = "job-media") {
    this.client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private get b() {
    return this.client.storage.from(this.bucket);
  }

  async createUploadTarget(path: string, opts: { contentType: string; sizeBytes: number; expiresInSeconds: number }): Promise<UploadTarget> {
    const { data, error } = await withTimeout("storage.signUpload", 8000, () => this.b.createSignedUploadUrl(path));
    if (error || !data) throw Object.assign(new Error("storage sign failed"), { code: "STORAGE_UNAVAILABLE", cause: error });
    // Supabase signed upload tokens last 2 hours; our own (shorter) expiry is enforced when the upload is completed.
    const expiresAt = new Date(Date.now() + opts.expiresInSeconds * 1000).toISOString();
    if (opts.sizeBytes > RESUMABLE_THRESHOLD_BYTES) {
      return {
        mode: "tus",
        endpoint: `${this.url}/storage/v1/upload/resumable/sign`,
        headers: { apikey: this.anonKey, "x-signature": data.token },
        metadata: { bucketName: this.bucket, objectName: path, contentType: opts.contentType },
        chunkSize: TUS_CHUNK_BYTES,
        expiresAt,
      };
    }
    return { mode: "put", url: data.signedUrl, headers: { "content-type": opts.contentType, apikey: this.anonKey }, expiresAt };
  }

  async head(path: string, bytes: number) {
    const url = await this.signedReadUrl(path, 60);
    const res = await withTimeout("storage.head", 8000, (signal) => fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal }));
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw Object.assign(new Error(`storage head ${res.status}`), { code: "STORAGE_UNAVAILABLE" });
    const range = res.headers.get("content-range");
    const size = range ? Number(range.split("/")[1]) : Number(res.headers.get("content-length"));
    const head = new Uint8Array(await res.arrayBuffer()).slice(0, bytes);
    return { head, size };
  }

  async stream(path: string): Promise<Readable> {
    const url = await this.signedReadUrl(path, 300);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw Object.assign(new Error(`storage stream ${res.status}`), { code: "STORAGE_UNAVAILABLE" });
    return Readable.fromWeb(res.body as unknown as NodeReadableStream);
  }

  async put(path: string, body: Buffer, contentType: string): Promise<void> {
    const { error } = await this.b.upload(path, body, { contentType, upsert: true });
    if (error) throw Object.assign(new Error("storage put failed"), { code: "STORAGE_UNAVAILABLE", cause: error });
  }

  async signedReadUrl(path: string, ttlSeconds: number): Promise<string> {
    const { data, error } = await this.b.createSignedUrl(path, ttlSeconds);
    if (error || !data) throw Object.assign(new Error("storage signed url failed"), { code: "STORAGE_UNAVAILABLE", cause: error });
    return data.signedUrl;
  }

  async remove(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const { error } = await this.b.remove(paths);
    if (error) throw Object.assign(new Error("storage remove failed"), { code: "STORAGE_UNAVAILABLE", cause: error });
  }
}
