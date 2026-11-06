import "server-only";
import type { Readable } from "node:stream";
import { config } from "../config";
import { log } from "../observability/logger";

export type ScanResult = "clean" | "infected" | "not_scanned" | "scanner_unavailable";

/**
 * Malware scanning seam. If MALWARE_SCANNER_URL is set (e.g. a ClamAV REST
 * service returning {"infected": boolean}), files are streamed to it. Without
 * it, files are marked not_scanned and stay admin-only until a human reviews
 * them. Status: HTTP scanner client implemented, unverified.
 */
export async function scan(stream: Readable, filename: string): Promise<ScanResult> {
  const url = config().MALWARE_SCANNER_URL;
  if (!url) {
    stream.destroy();
    return "not_scanned";
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(filename) },
      body: stream as unknown as BodyInit,
      // @ts-expect-error Node fetch requires duplex for streamed bodies
      duplex: "half",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) return "scanner_unavailable";
    const body = (await res.json()) as { infected?: boolean };
    return body.infected ? "infected" : "clean";
  } catch (err) {
    log.warn("scanner.unavailable", { err });
    return "scanner_unavailable";
  }
}
