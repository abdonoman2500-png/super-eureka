import { cookies } from "next/headers";
import { logAudit, requireAuth } from "@/lib/server/auth";
import { handleRoute } from "@/lib/server/http";
import { UNLOCK_TOKEN_COOKIE } from "@/lib/shared/constants";

/** POST /api/auth/lock — re-locks the vault (clears the unlock token). */
export async function POST() {
  return handleRoute(async () => {
    const { user } = await requireAuth();
    const store = await cookies();
    store.delete(UNLOCK_TOKEN_COOKIE);
    await logAudit(user.id, "vault.lock");
    return Response.json({ ok: true });
  });
}
