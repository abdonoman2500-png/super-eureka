import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadSessions } from "@/db/schema";
import { requireUnlockedVault } from "@/lib/server/auth";
import { HttpError, handleRoute } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";
import { asUuid } from "@/lib/server/vault";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/uploads/:id/abort — discards uploaded parts and frees space. */
export async function POST(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const { id } = await ctx.params;
    const uploadId = asUuid(id);
    if (!uploadId) throw new HttpError(400, "معرّف غير صالح", "bad_id");

    const [session] = await db
      .select()
      .from(uploadSessions)
      .where(
        and(eq(uploadSessions.id, uploadId), eq(uploadSessions.userId, user.id)),
      )
      .limit(1);
    if (!session) throw new HttpError(404, "جلسة الرفع غير موجودة", "not_found");

    const driver = storage();
    if (session.providerUploadId) {
      await driver
        .abortMultipart(session.storageKey, session.providerUploadId)
        .catch(() => undefined);
    } else {
      await driver.deleteObject(session.storageKey).catch(() => undefined);
    }

    await db
      .update(uploadSessions)
      .set({ status: "aborted", completedAt: new Date() })
      .where(eq(uploadSessions.id, session.id));

    return Response.json({ ok: true });
  });
}
