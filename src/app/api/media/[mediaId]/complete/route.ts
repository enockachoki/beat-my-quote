import { route } from "@/server/http/handler";
import { uuidSchema } from "@/lib/schemas";
import * as media from "@/server/services/mediaService";

export const POST = route<{ mediaId: string }>({ auth: ["homeowner", "admin"] }, async (ctx) => ({
  body: await media.completeUpload(ctx.user!, uuidSchema.parse(ctx.params.mediaId)),
}));
