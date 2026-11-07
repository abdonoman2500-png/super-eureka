import bcrypt from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db";
import { auditLog, sessions, users, type User } from "@/db/schema";
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
  UNLOCK_TOKEN_COOKIE,
  UNLOCK_TOKEN_TTL_SECONDS,
} from "@/lib/shared/constants";
import {
  randomToken,
  sha256Hex,
  signJwt,
  verifyJwt,
  type JwtPayload,
} from "./tokens";
import { HttpError } from "./http";

const BCRYPT_ROUNDS = 12;

export async function hashSecret(value: string): Promise<string> {
  return bcrypt.hash(value, BCRYPT_ROUNDS);
}

export async function verifySecret(
  value: string,
  hash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(value, hash);
  } catch {
    return false;
  }
}

const cookieBase = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export async function issueSession(
  userId: string,
  userAgent?: string | null,
): Promise<SessionTokens> {
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await db.insert(sessions).values({
    userId,
    tokenHash: sha256Hex(refreshToken),
    userAgent: userAgent?.slice(0, 400) ?? null,
    expiresAt,
  });
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256Hex(refreshToken)))
    .limit(1);
  const accessToken = signJwt(
    { sub: userId, typ: "access", sid: row?.id ?? "anon" },
    ACCESS_TOKEN_TTL_SECONDS,
  );
  return { accessToken, refreshToken };
}

export async function rotateSession(
  refreshToken: string,
): Promise<SessionTokens | null> {
  const tokenHash = sha256Hex(refreshToken);
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.id, row.id));
    return null;
  }
  // Rotation: retire the presented token, mint a fresh pair.
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, row.id));
  return issueSession(row.userId, row.userAgent);
}

export async function persistAuthCookies(tokens: SessionTokens) {
  const store = await cookies();
  store.set(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...cookieBase,
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
  store.set(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    ...cookieBase,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
  });
}

export async function clearAuthCookies() {
  const store = await cookies();
  store.delete(ACCESS_TOKEN_COOKIE);
  store.delete(REFRESH_TOKEN_COOKIE);
  store.delete(UNLOCK_TOKEN_COOKIE);
}

export async function setUnlockCookie(userId: string, sessionId: string) {
  const store = await cookies();
  const token = signJwt(
    { sub: userId, typ: "unlock", sid: sessionId },
    UNLOCK_TOKEN_TTL_SECONDS,
  );
  store.set(UNLOCK_TOKEN_COOKIE, token, {
    ...cookieBase,
    maxAge: UNLOCK_TOKEN_TTL_SECONDS,
  });
  return token;
}

export async function readAccessToken(): Promise<JwtPayload | null> {
  const store = await cookies();
  return verifyJwt(store.get(ACCESS_TOKEN_COOKIE)?.value);
}

export interface AuthContext {
  user: User;
  sessionId: string;
}

async function loadUser(userId: string): Promise<User | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

/** Session-guarded context (metadata API). */
export async function getAuthContext(): Promise<AuthContext | null> {
  const payload = await readAccessToken();
  if (!payload || payload.typ !== "access") return null;
  const user = await loadUser(payload.sub);
  if (!user) return null;
  return { user, sessionId: payload.sid ?? "anon" };
}

export async function requireAuth(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) throw new HttpError(401, "الجلسة غير صالحة", "unauthorized");
  return context;
}

/** Vault-guarded context: valid session *and* an unlocked vault token. */
export async function requireUnlockedVault(): Promise<AuthContext> {
  const context = await requireAuth();
  const store = await cookies();
  const unlock = verifyJwt(store.get(UNLOCK_TOKEN_COOKIE)?.value);
  if (!unlock || unlock.typ !== "unlock" || unlock.sub !== context.user.id) {
    throw new HttpError(423, "الخزنة مقفلة — أدخل رمز الأمان", "vault_locked");
  }
  return context;
}

export async function revokeByRefreshToken(refreshToken: string) {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.tokenHash, sha256Hex(refreshToken)));
}

export async function logAudit(
  userId: string | null,
  action: string,
  detail?: Record<string, unknown>,
) {
  try {
    await db.insert(auditLog).values({ userId, action, detail: detail ?? null });
  } catch {
    /* auditing must never break the request path */
  }
}

/**
 * Atomically add bytes to a user's usage counter while enforcing the 1 TB cap.
 */
export async function consumeStorage(
  userId: string,
  bytes: number,
): Promise<{ used: number; limit: number }> {
  const [row] = await db
    .update(users)
    .set({ storageUsedBytes: sql`${users.storageUsedBytes} + ${bytes}` })
    .where(
      and(
        eq(users.id, userId),
        sql`${users.storageUsedBytes} + ${bytes} <= ${users.storageLimitBytes}`,
      ),
    )
    .returning({
      used: users.storageUsedBytes,
      limit: users.storageLimitBytes,
    });
  if (!row) {
    throw new HttpError(507, "تم استهلاك كامل المساحة التخزينية (1 TB)", "quota_exceeded");
  }
  return row;
}

export async function releaseStorage(userId: string, bytes: number) {
  await db
    .update(users)
    .set({
      storageUsedBytes: sql`GREATEST(${users.storageUsedBytes} - ${bytes}, 0)`,
    })
    .where(eq(users.id, userId));
}
