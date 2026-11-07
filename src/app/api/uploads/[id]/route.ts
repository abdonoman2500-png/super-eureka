import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { uploadSessions } from "@/db/schema";
import { requireUnlockedVault } from "@/lib/server/auth";
import { HttpError, handleRoute } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";
import { asUuid } from "@/lib/server/vault";
import type { InitUploadResponse } from "@/lib/shared/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/uploads/:id — re-mints pre-signed part URLs so a paused or
 * interrupted upload can resume after an app restart or network drop.
 */
export async function GET(request: Request, ctx: Ctx) {
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
    if (session.status !== "pending") {
      throw new HttpError(409, "جلسة الرفع منتهية بالفعل", "not_pending");
    }

    const driver = storage();
    const multipart = Boolean(session.providerUploadId);
    const partUrls = Array.from({ length: session.totalParts }, (_, index) =>
      driver.presignPut(session.storageKey, {
        partNumber: index + 1,
        uploadId: session.providerUploadId ?? undefined,
      }),
    );

    const payload: InitUploadResponse = {
      uploadId: session.id,
      storageKey: session.storageKey,
      partSize: session.partSize,
      totalParts: session.totalParts,
      mode: multipart ? "multipart" : "single",
      putUrl: multipart ? null : partUrls[0] ?? null,
      partUrls,
    };
    return Response.json(payload);
  });
}
