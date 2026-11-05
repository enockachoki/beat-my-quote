import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { createReadStream, enabled, fullPath, notFound, size, token } from "../../_shared";

export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf", mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

/** Emulates a signed, expiring read URL. Supports Range for video seeking. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!enabled()) return notFound();
  const t = token((await ctx.params).token, "get");
  if (!t) return NextResponse.json({ error: "invalid or expired token" }, { status: 403 });
  const file = fullPath(t.p);
  const total = await size(file);
  if (total === null) return notFound();
  const type = TYPES[t.p.split(".").pop() ?? ""] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Cross-Origin-Resource-Policy": "same-origin" };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start > end) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
    return new NextResponse(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
  return new NextResponse(stream, { status: 200, headers: { ...headers, "Content-Length": String(total) } });
}
