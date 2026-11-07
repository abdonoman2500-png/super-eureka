import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { authChallenges, deviceCredentials } from "@/db/schema";
import {
  logAudit,
  requireAuth,
  setUnlockCookie,
} from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";
import {
  verifyChallengeSeal,
  type PublicKeyJwk,
} from "@/lib/server/biometric";

/**
 * POST /api/auth/biometric/verify
 * Completes the device proof-of-possession round and unlocks the vault.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { user, sessionId } = await requireAuth();
    const body = await readJson<{
      challengeId?: string;
      credentialId?: string;
      iv?: string;
      ciphertext?: string;
    }>(request);

    const challengeId = assertString(body.challengeId, "معرّف التحدي")!;
    const credentialId = assertString(body.credentialId, "معرّف الجهاز")!;
    const iv = assertString(body.iv, "متجه التهيئة")!;
    const ciphertext = assertString(body.ciphertext, "النص المشفر")!;

    const [challenge] = await db
      .select()
      .from(authChallenges)
      .where(
        and(eq(authChallenges.id, challengeId), isNull(authChallenges.consumedAt)),
      )
      .limit(1);
    if (!challenge || challenge.expiresAt.getTime() < Date.now()) {
      throw new HttpError(400, "انتهت صلاحية التحدي", "challenge_expired");
    }

    const [credential] = await db
      .select()
      .from(deviceCredentials)
      .where(
        and(
          eq(deviceCredentials.credentialId, credentialId),
          eq(deviceCredentials.userId, user.id),
        ),
      )
      .limit(1);
    if (!credential || challenge.credentialId !== credentialId) {
      throw new HttpError(400, "تحدي غير مطابق للجهاز", "challenge_mismatch");
    }

    const ok = verifyChallengeSeal(
      challenge.ephemeralPrivateKey,
      credential.publicKeyJwk as PublicKeyJwk,
      iv,
      ciphertext,
      challenge.nonce,
    );

    await db
      .update(authChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(authChallenges.id, challenge.id));

    if (!ok) {
      await logAudit(user.id, "biometric.failed", { credentialId });
      throw new HttpError(401, "فشل التحقق من بصمة الجهاز", "bad_signature");
    }

    await setUnlockCookie(user.id, sessionId);
    await logAudit(user.id, "biometric.verified", { credentialId });
    return Response.json({ ok: true });
  });
}
