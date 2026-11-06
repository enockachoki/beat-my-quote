import { route } from "@/server/http/handler";

export const GET = route({ auth: "any" }, async (ctx) => ({ body: { id: ctx.user!.id, role: ctx.user!.role } }));
