import type { AllowedMime } from "@/lib/fileTypes";

/**
 * Detects the real file type from its first bytes ("magic numbers"). We never
 * trust the filename or the browser-supplied Content-Type. Needs >= 32 bytes.
 */
export function sniffMime(head: Uint8Array): AllowedMime | null {
  const b = head;
  const at = (i: number, ...bytes: number[]) => bytes.every((v, j) => b[i + j] === v);
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)));

  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...Array.from(b.slice(8, 12)));
    if (brand === "qt  ") return "video/quicktime";
    if (["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VP", "dash", "MSNV"].includes(brand)) return "video/mp4";
    return null; // e.g. HEIC ("heic"/"mif1") is deliberately not accepted
  }
  return null;
}

/** Image/PDF/video families must agree: a PNG declared as JPEG is fine, a PDF declared as JPEG is not. */
export function sameFamily(declared: AllowedMime, detected: AllowedMime): boolean {
  const fam = (m: AllowedMime) => (m.startsWith("image/") ? "image" : m.startsWith("video/") ? "video" : "pdf");
  return fam(declared) === fam(detected);
}
