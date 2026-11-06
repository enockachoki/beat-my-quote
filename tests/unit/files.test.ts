import { describe, expect, it } from "vitest";
import { sameFamily, sniffMime } from "@/server/domain/fileSniff";
import { fileFingerprint, preCheckFile, sanitiseFilename } from "@/lib/fileTypes";

const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(32).fill(0)]);
const ascii = (s: string, pad = 32) => new Uint8Array([...Array.from(s, (c) => c.charCodeAt(0)), ...new Array(pad).fill(0)]);
const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x18, ...Array.from("ftyp" + brand, (c) => c.charCodeAt(0)), ...new Array(20).fill(0)]);

describe("sniffMime (content, not filename)", () => {
  it.each([
    ["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0), "image/jpeg"],
    ["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image/png"],
    ["webp", ascii("RIFF\0\0\0\0WEBPVP8 "), "image/webp"],
    ["pdf", ascii("%PDF-1.7"), "application/pdf"],
    ["mp4", ftyp("isom"), "video/mp4"],
    ["mp4 (mp42)", ftyp("mp42"), "video/mp4"],
    ["mov", ftyp("qt  "), "video/quicktime"],
    ["webm", bytes(0x1a, 0x45, 0xdf, 0xa3), "video/webm"],
  ])("detects %s", (_n, head, mime) => {
    expect(sniffMime(head)).toBe(mime);
  });
  it.each([
    ["html pretending to be an image", ascii("<html><script>alert(1)</script>")],
    ["svg (scriptable, not allowed)", ascii("<svg xmlns='http://www.w3.org/2000/svg'>")],
    ["windows executable", ascii("MZ\x90\0")],
    ["zip", bytes(0x50, 0x4b, 0x03, 0x04)],
    ["heic", ftyp("heic")],
    ["empty", new Uint8Array(0)],
  ])("rejects %s", (_n, head) => {
    expect(sniffMime(head)).toBeNull();
  });
  it("accepts a PNG declared as JPEG but not a PDF declared as an image", () => {
    expect(sameFamily("image/jpeg", "image/png")).toBe(true);
    expect(sameFamily("image/jpeg", "application/pdf")).toBe(false);
    expect(sameFamily("video/mp4", "image/jpeg")).toBe(false);
  });
});

describe("preCheckFile", () => {
  it("accepts allowed types for each kind", () => {
    expect(preCheckFile({ name: "a.JPG", size: 1000, type: "image/jpeg" }, "photo").ok).toBe(true);
    expect(preCheckFile({ name: "q.pdf", size: 1000, type: "application/pdf" }, "quote_document").ok).toBe(true);
    expect(preCheckFile({ name: "v.mov", size: 1000, type: "video/quicktime" }, "video").ok).toBe(true);
  });
  it("rejects wrong kinds, extensions and types", () => {
    expect(preCheckFile({ name: "q.pdf", size: 1000, type: "application/pdf" }, "photo")).toEqual({ ok: false, code: "UPLOAD_INVALID_TYPE" });
    expect(preCheckFile({ name: "a.exe", size: 1000, type: "image/jpeg" }, "photo")).toEqual({ ok: false, code: "UPLOAD_INVALID_TYPE" });
    expect(preCheckFile({ name: "a.svg", size: 1000, type: "image/svg+xml" }, "photo")).toEqual({ ok: false, code: "UPLOAD_INVALID_TYPE" });
    expect(preCheckFile({ name: "a.jpg.html", size: 1000, type: "image/jpeg" }, "photo")).toEqual({ ok: false, code: "UPLOAD_INVALID_TYPE" });
  });
  it("enforces size limits per category", () => {
    expect(preCheckFile({ name: "a.jpg", size: 21 * 1024 * 1024, type: "image/jpeg" }, "photo")).toEqual({ ok: false, code: "UPLOAD_TOO_LARGE" });
    expect(preCheckFile({ name: "v.mp4", size: 501 * 1024 * 1024, type: "video/mp4" }, "video")).toEqual({ ok: false, code: "UPLOAD_TOO_LARGE" });
    expect(preCheckFile({ name: "v.mp4", size: 0, type: "video/mp4" }, "video")).toEqual({ ok: false, code: "UPLOAD_TOO_LARGE" });
  });
  it("sanitises filenames and builds stable fingerprints", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitiseFilename("C:\\Users\\me\\<bad>?.jpg")).toBe("bad.jpg");
    expect(sanitiseFilename("\u0000\u0007")).toBe("file");
    expect(fileFingerprint({ name: "a.jpg", size: 5, lastModified: 9 })).toBe("a.jpg:5:9");
  });
});
