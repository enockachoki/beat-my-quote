import { route } from "@/server/http/handler";
import { mediaIntentSchema, uuidSchema } from "@/lib/schemas";
import * as media from "@/server/services/mediaService";
import { RULES } from "@/server/services/rateLimit";

export const POST = route<{ jobId: string }>({ auth: ["homeowner", "admin"], rateLimit: RULES.uploadIntent }, async (ctx) => {
  const { kind, files } = await ctx.body(mediaIntentSchema);
  return { body: { results: await media.createIntents(ctx.user!, uuidSchema.parse(ctx.params.jobId), kind, files) } };
});
