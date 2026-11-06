import { NextResponse, type NextRequest } from "next/server";
import { enabled, fullPath, notFound, rename, streamToFile, token } from "../../_shared";

export const dynamic = "force-dynamic";

/** Emulates a signed single-request upload (PUT), like Supabase's signed upload URL. */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  if (!enabled()) return notFound();
  const t = token((await ctx.params).token, "put");
  if (!t) return NextResponse.json({ error: "invalid or expired token" }, { status: 403 });
  const file = fullPath(t.p);
  try {
    await streamToFile(req.body, file + ".part", "w", t.max ?? 0);
    await rename(file + ".part", file);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message === "TOO_LARGE" ? "too large" : "upload failed" }, { status: (err as Error).message === "TOO_LARGE" ? 413 : 500 });
  }
  return NextResponse.json({ ok: true });
}
