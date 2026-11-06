import { z } from "zod";
import { route } from "@/server/http/handler";
import { withServiceTx } from "@/server/db/client";

export const GET = route({ auth: ["admin"] }, async (ctx) => {
  const q = ctx.query(z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }));
  const rows = await withServiceTx((tx) => tx<{ id: number }[]>`
    select id, at, actor_id, actor_role, action, entity_type, entity_id, correlation_id, details from public.audit_log
    ${q.before ? tx`where id < ${q.before}` : tx``} order by id desc limit ${q.limit}`);
  return { body: { items: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null } };
});
