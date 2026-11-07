import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  issueSession,
  logAudit,
  persistAuthCookies,
  verifySecret,
} from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";
import { publicUser } from "@/lib/server/serialize";

/** POST /api/auth/login — password grant, rotates a fresh session pair. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await readJson<{ email?: string; password?: string }>(request);
    const email = assertString(body.email, "البريد الإلكتروني")!.toLowerCase();
    const password = assertString(body.password, "كلمة المرور")!;

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user) {
      throw new HttpError(401, "بيانات الدخول غير صحيحة", "bad_credentials");
    }

    const ok = await verifySecret(password, user.passwordHash);
    if (!ok) {
      await logAudit(user.id, "auth.login_failed");
      throw new HttpError(401, "بيانات الدخول غير صحيحة", "bad_credentials");
    }

    const tokens = await issueSession(user.id, request.headers.get("user-agent"));
    await persistAuthCookies(tokens);
    await logAudit(user.id, "auth.login");

    return Response.json({ user: publicUser(user), requiresUnlock: true });
  });
}
