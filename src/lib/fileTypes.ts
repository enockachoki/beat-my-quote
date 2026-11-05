/** Upload policy shared by browser (pre-checks) and server (authoritative checks). */
export type MediaKind = "photo" | "video" | "quote_document" | "quote_redacted";

export const ALLOWED_MIME = {
  "image/jpeg": { exts: ["jpg", "jpeg"], category: "image" },
  "image/png": { exts: ["png"], category: "image" },
  "image/webp": { exts: ["webp"], category: "image" },
  "application/pdf": { exts: ["pdf"], category: "pdf" },
  "video/mp4": { exts: ["mp4", "m4v"], category: "video" },
  "video/quicktime": { exts: ["mov"], category: "video" },
  "video/webm": { exts: ["webm"], category: "video" },
} as const;

export type AllowedMime = keyof typeof ALLOWED_MIME;
export type MediaCategory = (typeof ALLOWED_MIME)[AllowedMime]["category"];

export const KIND_ALLOWED_CATEGORIES: Record<MediaKind, readonly MediaCategory[]> = {
  photo: ["image"],
  video: ["video"],
  quote_document: ["image", "pdf"],
  quote_redacted: ["image", "pdf"],
};

export interface UploadLimits {
  maxImageBytes: number;
  maxPdfBytes: number;
  maxVideoBytes: number;
  maxFilesPerJob: number;
  maxVideosPerJob: number;
}

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxPdfBytes: 15 * 1024 * 1024,
  maxVideoBytes: 500 * 1024 * 1024,
  maxFilesPerJob: 30,
  maxVideosPerJob: 3,
};

export function isAllowedMime(mime: string): mime is AllowedMime {
  return Object.prototype.hasOwnProperty.call(ALLOWED_MIME, mime);
}

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

export function maxBytesFor(category: MediaCategory, limits: UploadLimits): number {
  if (category === "image") return limits.maxImageBytes;
  if (category === "pdf") return limits.maxPdfBytes;
  return limits.maxVideoBytes;
}

/** Removes path parts and control/odd characters; keeps a readable name. */
export function sanitiseFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  return (cleaned || "file").slice(0, 200);
}

export type PreCheck =
  | { ok: true; mime: AllowedMime; category: MediaCategory }
  | { ok: false; code: "UPLOAD_INVALID_TYPE" | "UPLOAD_TOO_LARGE" };

/**
 * Checks the declared type, extension and size. This is a first pass only; the
 * server re-checks the real bytes after upload (see server/domain/fileSniff.ts).
 */
export function preCheckFile(
  file: { name: string; size: number; type: string },
  kind: MediaKind,
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): PreCheck {
  const mime = file.type.toLowerCase();
  if (!isAllowedMime(mime)) return { ok: false, code: "UPLOAD_INVALID_TYPE" };
  const spec = ALLOWED_MIME[mime];
  const ext = extensionOf(file.name);
  if (!(spec.exts as readonly string[]).includes(ext)) return { ok: false, code: "UPLOAD_INVALID_TYPE" };
  if (!KIND_ALLOWED_CATEGORIES[kind].includes(spec.category)) return { ok: false, code: "UPLOAD_INVALID_TYPE" };
  if (file.size <= 0 || file.size > maxBytesFor(spec.category, limits)) return { ok: false, code: "UPLOAD_TOO_LARGE" };
  return { ok: true, mime, category: spec.category };
}

export function fileFingerprint(file: { name: string; size: number; lastModified: number }): string {
  return `${sanitiseFilename(file.name)}:${file.size}:${file.lastModified}`;
}
