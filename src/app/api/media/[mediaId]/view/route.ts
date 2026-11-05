import { NextResponse } from "next/server";
import { z } from "zod";
import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as media from "@/server/services/mediaService";

/** Redirects to a short-lived signed URL after an authorisation check. */
export const GET = route<{ mediaId: string }>({ auth: "any" }, async (ctx) => {
  const { variant } = ctx.query(z.object({ variant: z.enum(["thumb", "full"]).default("full") }));
  const url = await media.signedViewUrl(ctx.user!, uuidSchema.parse(ctx.params.mediaId), variant);
  return NextResponse.redirect(url, { status: 303 });
});
