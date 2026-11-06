import type { Readable } from "node:stream";

export type UploadTarget =
  | { mode: "put"; url: string; headers: Record<string, string>; expiresAt: string }
  | { mode: "tus"; endpoint: string; headers: Record<string, string>; metadata: Record<string, string>; chunkSize: number; expiresAt: string };

export interface StorageProvider {
  readonly name: string;
  /** Short-lived, path-scoped upload target. Never exposes privileged credentials. */
  createUploadTarget(path: string, opts: { contentType: string; sizeBytes: number; expiresInSeconds: number }): Promise<UploadTarget>;
  /** First `bytes` bytes plus total size, or null when the object doesn't exist. */
  head(path: string, bytes: number): Promise<{ head: Uint8Array; size: number } | null>;
  /** Streams the object; callers must not buffer large videos. */
  stream(path: string): Promise<Readable>;
  put(path: string, body: Buffer, contentType: string): Promise<void>;
  signedReadUrl(path: string, ttlSeconds: number): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

/** Files above this go through resumable (TUS) upload. Supabase requires 6 MB chunks. */
export const RESUMABLE_THRESHOLD_BYTES = 6 * 1024 * 1024;
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
