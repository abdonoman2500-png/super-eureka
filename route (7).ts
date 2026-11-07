import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  logAudit,
  requireAuth,
  setUnlockCookie,
  verifySecret,
} from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

/**
 * POST /api/auth/pin
 * App-lock gate: verifies the salted PIN hash server-side, with brute-force
 * lockout, then mints a short-lived vault-unlock token.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { user, sessionId } = await requireAuth();
    const body = await readJson<{ pin?: string }>(request);
    const pin = assertString(body.pin, "رمز الأمان", { min: 4, max: 6 })!;

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new HttpError(
        429,
        `تم قفل الخزنة مؤقتاً. أعد المحاولة بعد ${seconds} ثانية`,
        "locked",
      );
    }

    const ok = await verifySecret(pin, user.pinHash);
    if (!ok) {
      const attempts = user.failedPinAttempts + 1;
      await db
        .update(users)
        .set({
          failedPinAttempts: attempts,
          lockedUntil:
            attempts >= MAX_ATTEMPTS
              ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
              : null,
        })
        .where(eq(users.id, user.id));
      await logAudit(user.id, "pin.failed", { attempts });
      throw new HttpError(401, "رمز الأمان غير صحيح", "bad_pin");
    }

    await db
      .update(users)
      .set({ failedPinAttempts: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    await setUnlockCookie(user.id, sessionId);
    await logAudit(user.id, "pin.verified");

    return Response.json({ ok: true });
  });
}
