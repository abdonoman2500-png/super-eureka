import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { files, uploadSessions } from "@/db/schema";
import {
  consumeStorage,
  logAudit,
  requireUnlockedVault,
} from "@/lib/server/auth";
import { HttpError, handleRoute, readJson } from "@/lib/server/http";
import { storage, type CompletedPart } from "@/lib/server/storage";
import { serializeFile } from "@/lib/server/serialize";
import { asUuid } from "@/lib/server/vault";

type Ctx = { params: Promise<{ id: string }> };

interface CompleteBody {
  parts?: { partNumber: number; etag: string; size: number }[];
  fileName?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * POST /api/uploads/:id/complete
 * Finalises the multipart upload at the object store, commits file metadata
 * and atomically increments the user's storage counter.
 */
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
    if (session.status === "completed") {
      throw new HttpError(409, "تم إتمام هذا الرفع مسبقاً", "already_done");
    }

    const body = await readJson<CompleteBody>(request);
    const parts: CompletedPart[] = (body.parts ?? [])
      .filter((part) => Number.isFinite(part.partNumber) && part.etag)
      .map((part) => ({
        partNumber: Number(part.partNumber),
        etag: String(part.etag),
        size: Number(part.size) || 0,
      }));

    const driver = storage();
    let storedBytes = parts.reduce((sum, part) => sum + part.size, 0);

    if (session.providerUploadId) {
      if (parts.length === 0) {
        throw new HttpError(400, "لا توجد أجزاء مرفوعة", "no_parts");
      }
      const result = await driver.completeMultipart(
        session.storageKey,
        session.providerUploadId,
        parts,
      );
      storedBytes = result.storedBytes;
    } else {
      const stat = await driver.statObject(session.storageKey);
      if (stat !== null) storedBytes = stat;
      if (storedBytes === 0) {
        throw new HttpError(400, "لم يتم رفع أي بيانات", "empty_object");
      }
    }

    if (session.kind === "thumbnail") {
      await db
        .update(files)
        .set({ thumbnailKey: session.storageKey })
        .where(
          and(
            eq(files.id, session.parentFileId ?? "00000000-0000-0000-0000-000000000000"),
            eq(files.userId, user.id),
          ),
        );
    } else {
      const quota = await consumeStorage(user.id, storedBytes);
      await db.insert(files).values({
        userId: user.id,
        folderId: session.folderId,
        fileName: (body.fileName ?? session.fileName).slice(0, 255),
        fileSizeBytes: Number(session.declaredBytes),
        storedBytes,
        mimeType: session.mimeType,
        s3StorageKey: session.storageKey,
        width: Number.isFinite(body.width) ? Number(body.width) : null,
        height: Number.isFinite(body.height) ? Number(body.height) : null,
        durationSeconds: Number.isFinite(body.durationSeconds)
          ? Number(body.durationSeconds)
          : null,
      });
      await logAudit(user.id, "upload.complete", {
        storedBytes,
        quotaUsed: quota.used,
      });
    }

    await db
      .update(uploadSessions)
      .set({
        status: "completed",
        storedBytes,
        completedAt: new Date(),
      })
      .where(eq(uploadSessions.id, session.id));

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, user.id), eq(files.s3StorageKey, session.storageKey)))
      .limit(1);

    return Response.json({
      ok: true,
      storedBytes,
      file: file ? serializeFile(file) : null,
    });
  });
}
