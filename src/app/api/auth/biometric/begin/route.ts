import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { authChallenges, deviceCredentials } from "@/db/schema";
import { requireAuth } from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";
import { createEphemeralChallenge } from "@/lib/server/biometric";

/**
 * POST /api/auth/biometric/begin
 * Issues a single-use server challenge bound to the enrolled device key.
 * Response contains an ephemeral ECDH public key (SPKI, base64url) which the
 * device combines with its private half to derive the AES-GCM sealing key.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { user } = await requireAuth();
    const body = await readJson<{ credentialId?: string }>(request);
    const credentialId = assertString(body.credentialId, "معرّف الجهاز", {
      min: 8,
      max: 128,
    })!;

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
    if (!credential) {
      throw new HttpError(404, "لم يتم تسجيل هذا الجهاز", "not_enrolled");
    }

    const challenge = createEphemeralChallenge();
    const [row] = await db
      .insert(authChallenges)
      .values({
        userId: user.id,
        credentialId,
        ephemeralPrivateKey: challenge.ephemeralPrivateKey,
        nonce: challenge.nonce,
        expiresAt: new Date(Date.now() + 120 * 1000),
      })
      .returning({ id: authChallenges.id });

    return Response.json({
      challengeId: row.id,
      ephemeralPublicKey: challenge.ephemeralPublicKey,
      nonce: challenge.nonce,
    });
  });
}
