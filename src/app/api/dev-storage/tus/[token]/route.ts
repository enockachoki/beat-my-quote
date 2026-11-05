import { NextResponse, type NextRequest } from "next/server";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { enabled, fullPath, notFound, rename, size, streamToFile, token } from "../../_shared";

export const dynamic = "force-dynamic";

/**
 * Minimal TUS 1.0 core protocol (create, offset HEAD, PATCH append) so that
 * resumable uploads behave locally as they do against Supabase Storage.
 * One upload per signed token; the Location is the token URL itself.
 */
const TUS = { "Tus-Resumable": "1.0.0" };

async function load(ctx: { params: Promise<{ token: string }> }) {
  if (!enabled()) return null;
  const t = token((await ctx.params).token, "tus");
  return t ? { t, file: fullPath(t.p) } : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const r = await load(ctx);
  if (!r) return notFound();
  const length = Number(req.headers.get("upload-length"));
  if (!Number.isSafeInteger(length) || length <= 0 || length > (r.t.max ?? 0)) return new NextResponse(null, { status: 413, headers: TUS });
  if ((await size(r.file + ".part")) === null) {
    await mkdir(path.dirname(r.file), { recursive: true });
    await writeFile(r.file + ".part", "");
  }
  return new NextResponse(null, { status: 201, headers: { ...TUS, Location: req.nextUrl.toString() } });
}

export async function HEAD(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const r = await load(ctx);
  if (!r) return notFound();
  const done = await size(r.file);
  if (done !== null) return new NextResponse(null, { status: 200, headers: { ...TUS, "Upload-Offset": String(done), "Upload-Length": String(done), "Cache-Control": "no-store" } });
  const partial = await size(r.file + ".part");
  if (partial === null) return new NextResponse(null, { status: 404, headers: TUS });
  return new NextResponse(null, { status: 200, headers: { ...TUS, "Upload-Offset": String(partial), "Upload-Length": String(r.t.max), "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const r = await load(ctx);
  if (!r) return notFound();
  if (req.headers.get("content-type") !== "application/offset+octet-stream") return new NextResponse(null, { status: 415, headers: TUS });
  const offset = Number(req.headers.get("upload-offset"));
  const current = await size(r.file + ".part");
  if (current === null) return new NextResponse(null, { status: 404, headers: TUS });
  if (offset !== current) return new NextResponse(null, { status: 409, headers: { ...TUS, "Upload-Offset": String(current) } });
  try {
    await streamToFile(req.body, r.file + ".part", "a", (r.t.max ?? 0) - current);
  } catch {
    // Partial chunk written: the client re-reads the offset with HEAD and resumes.
  }
  const now = (await size(r.file + ".part")) ?? 0;
  if (now === r.t.max) await rename(r.file + ".part", r.file);
  return new NextResponse(null, { status: 204, headers: { ...TUS, "Upload-Offset": String(now) } });
}
