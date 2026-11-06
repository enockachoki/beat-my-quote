import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness: the process is up. Does not touch dependencies. */
export function GET() {
  return NextResponse.json({ status: "ok", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
