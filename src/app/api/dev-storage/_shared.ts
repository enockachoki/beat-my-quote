import "server-only";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { config } from "@/server/config";
import { localStorageSecret } from "@/server/storage";
import { verifyToken, type StorageToken } from "@/server/storage/signing";

/** Dev/test storage emulator. Disabled unless STORAGE_PROVIDER=local outside production. */
export function enabled(): boolean {
  const cfg = config();
  return cfg.STORAGE_PROVIDER === "local" && cfg.APP_ENV !== "production";
}

export function notFound() {
  return new NextResponse(null, { status: 404 });
}

export function token(raw: string, op: StorageToken["op"]): StorageToken | null {
  return verifyToken(localStorageSecret(), decodeURIComponent(raw), op);
}

export function fullPath(p: string): string {
  const root = path.resolve(config().LOCAL_STORAGE_DIR);
  const full = path.resolve(root, p);
  if (!full.startsWith(root + path.sep)) throw new Error("bad path");
  return full;
}

export async function size(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** Streams a request body to disk (append or create) without buffering it in memory. */
export async function streamToFile(body: ReadableStream<Uint8Array> | null, file: string, flags: "w" | "a", maxBytes: number): Promise<number> {
  if (!body) return 0;
  await mkdir(path.dirname(file), { recursive: true });
  let written = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      written += chunk.length;
      if (written > maxBytes) cb(new Error("TOO_LARGE"));
      else cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(body as unknown as NodeReadableStream), limiter, createWriteStream(file, { flags }));
  return written;
}

export { createReadStream, rename };
