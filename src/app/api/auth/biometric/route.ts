import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { deviceCredentials } from "@/db/schema";
import { logAudit, requireAuth } from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";
import { assertPublicKeyJwk } from "@/lib/server/biometric";

/**
 * GET  /api/auth/biometric  — list enrolled devices
 * POST /api/auth/biometric  — enroll a device key (ECDH P-256 public JWK)
 * DELETE /api/auth/biometric?credentialId=... — remove a device
 */
export async function GET() {
  return handleRoute(async () => {
    const { user } = await requireAuth();
    const rows = await db
      .select()
      .from(deviceCredentials)
      .where(eq(deviceCredentials.userId, user.id));
    return Response.json({
      credentials: rows.map((row) => ({
        id: row.id,
        credentialId: row.credentialId,
        label: row.label,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  });
}

export async function POST(request: Request) {
  return handleRoute(async () => {
    const { user } = await requireAuth();
    const body = await readJson<{
      credentialId?: string;
      label?: string;
      publicKeyJwk?: unknown;
    }>(request);

    const credentialId = assertString(body.credentialId, "معرّف الجهاز", {
      min: 8,
      max: 128,
    })!;
    const publicKeyJwk = assertPublicKeyJwk(body.publicKeyJwk);

    const [existing] = await db
      .select({ id: deviceCredentials.id })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.credentialId, credentialId))
      .limit(1);

    if (existing) {
      await db
        .update(deviceCredentials)
        .set({ publicKeyJwk })
        .where(eq(deviceCredentials.id, existing.id));
    } else {
      await db.insert(deviceCredentials).values({
        userId: user.id,
        credentialId,
        publicKeyJwk,
        label:
          assertString(body.label, "التسمية", { optional: true, max: 160 }) ??
          "جهاز موثوق",
      });
    }
    await logAudit(user.id, "biometric.enrolled", { credentialId });
    return Response.json({ ok: true, credentialId });
  });
}

export async function DELETE(request: Request) {
  return handleRoute(async () => {
    const { user } = await requireAuth();
    const credentialId = new URL(request.url).searchParams.get("credentialId");
    if (!credentialId) {
      throw new HttpError(400, "معرّف الجهاز مطلوب", "missing_field");
    }
    await db
      .delete(deviceCredentials)
      .where(
        and(
          eq(deviceCredentials.credentialId, credentialId),
          eq(deviceCredentials.userId, user.id),
        ),
      );
    return Response.json({ ok: true });
  });
}

export const dynamic = "force-dynamic";
