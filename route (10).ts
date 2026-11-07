import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { files } from "@/db/schema";
import {
  logAudit,
  releaseStorage,
  requireUnlockedVault,
} from "@/lib/server/auth";
import { HttpError, handleRoute, readJson } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";
import { serializeFile } from "@/lib/server/serialize";
import { asUuid } from "@/lib/server/vault";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/files/:id — rename, move, favorite. */
export async function PATCH(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const { id } = await ctx.params;
    const fileId = asUuid(id);
    if (!fileId) throw new HttpError(400, "معرّف غير صالح", "bad_id");

    const body = await readJson<{
      fileName?: string;
      folderId?: string | null;
      isFavorite?: boolean;
    }>(request);

    const patch: Partial<typeof files.$inferInsert> = {};
    if (typeof body.fileName === "string" && body.fileName.trim()) {
      patch.fileName = body.fileName.trim().slice(0, 255);
    }
    if (body.folderId !== undefined) patch.folderId = asUuid(body.folderId);
    if (typeof body.isFavorite === "boolean") patch.isFavorite = body.isFavorite;

    const [updated] = await db
      .update(files)
      .set(patch)
      .where(and(eq(files.id, fileId), eq(files.userId, user.id)))
      .returning();
    if (!updated) throw new HttpError(404, "الملف غير موجود", "not_found");

    await logAudit(user.id, "file.update", { fileId, patch: Object.keys(patch) });
    return Response.json({ file: serializeFile(updated) });
  });
}

/** DELETE /api/files/:id — destroys ciphertext + frees quota atomically. */
export async function DELETE(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const { id } = await ctx.params;
    const fileId = asUuid(id);
    if (!fileId) throw new HttpError(400, "معرّف غير صالح", "bad_id");

    const [file] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.userId, user.id)))
      .limit(1);
    if (!file) throw new HttpError(404, "الملف غير موجود", "not_found");

    const driver = storage();
    await driver.deleteObject(file.s3StorageKey).catch(() => undefined);
    if (file.thumbnailKey) {
      await driver.deleteObject(file.thumbnailKey).catch(() => undefined);
    }
    await db.delete(files).where(eq(files.id, fileId));
    await releaseStorage(user.id, Number(file.storedBytes));
    await logAudit(user.id, "file.delete", { fileId });

    return Response.json({ ok: true });
  });
}
