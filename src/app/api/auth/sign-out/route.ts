import { route } from "@/server/http/handler";
import * as accounts from "@/server/services/accountService";

export const POST = route({ auth: "public" }, async () => {
  await accounts.signOut();
  return { body: { ok: true } };
});
