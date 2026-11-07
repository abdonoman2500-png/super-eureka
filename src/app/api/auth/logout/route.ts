import { cookies } from "next/headers";
import {
  clearAuthCookies,
  logAudit,
  revokeByRefreshToken,
} from "@/lib/server/auth";
import { handleRoute } from "@/lib/server/http";
import { REFRESH_TOKEN_COOKIE } from "@/lib/shared/constants";

/** POST /api/auth/logout — revokes the refresh token and clears cookies. */
export async function POST() {
  return handleRoute(async () => {
    const store = await cookies();
    const presented = store.get(REFRESH_TOKEN_COOKIE)?.value;
    if (presented) await revokeByRefreshToken(presented);
    await clearAuthCookies();
    await logAudit(null, "auth.logout");
    return Response.json({ ok: true });
  });
}
