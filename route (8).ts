import { cookies } from "next/headers";
import {
  clearAuthCookies,
  logAudit,
  persistAuthCookies,
  rotateSession,
} from "@/lib/server/auth";
import { HttpError, handleRoute } from "@/lib/server/http";
import { REFRESH_TOKEN_COOKIE } from "@/lib/shared/constants";

/** POST /api/auth/refresh — refresh-token rotation. */
export async function POST() {
  return handleRoute(async () => {
    const store = await cookies();
    const presented = store.get(REFRESH_TOKEN_COOKIE)?.value;
    if (!presented) throw new HttpError(401, "لا توجد جلسة للتجديد", "no_session");

    const tokens = await rotateSession(presented);
    if (!tokens) {
      await clearAuthCookies();
      throw new HttpError(401, "انتهت صلاحية الجلسة", "session_expired");
    }
    await persistAuthCookies(tokens);
    await logAudit(null, "auth.refresh");
    return Response.json({ ok: true });
  });
}
