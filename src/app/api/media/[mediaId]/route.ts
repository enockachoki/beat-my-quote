import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as media from "@/server/services/mediaService";

export const DELETE = route<{ mediaId: string }>({ auth: ["homeowner", "admin"] }, async (ctx) => {
  await media.removeMedia(ctx.user!, uuidSchema.parse(ctx.params.mediaId));
  return { body: { ok: true } };
});
