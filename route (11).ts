import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { files, folders } from "@/db/schema";
import { logAudit, releaseStorage, requireUnlockedVault } from "@/lib/server/auth";
import { HttpError, handleRoute, readJson } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";
import { serializeFolder } from "@/lib/server/serialize";
import { asUuid, collectFolderTree } from "@/lib/server/vault";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/folders/:id — rename and/or move (cycle-safe). */
export async function PATCH(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const { id } = await ctx.params;
    const folderId = asUuid(id);
    if (!folderId) throw new HttpError(400, "معرّف غير صالح", "bad_id");

    const [folder] = await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, folderId), eq(folders.userId, user.id)))
      .limit(1);
    if (!folder) throw new HttpError(404, "المجلد غير موجود", "not_found");

    const body = await readJson<{ name?: string; parentId?: string | null }>(request);
    const patch: Partial<typeof folders.$inferInsert> = {};

    if (typeof body.name === "string" && body.name.trim()) {
      patch.name = body.name.trim().slice(0, 255);
    }
    if (body.parentId !== undefined) {
      const parentId = asUuid(body.parentId);
      if (parentId) {
        if (parentId === folderId) {
          throw new HttpError(400, "لا يمكن نقل المجلد إلى نفسه", "cycle");
        }
        const descendants = await collectFolderTree(user.id, folderId);
        if (descendants.includes(parentId)) {
          throw new HttpError(400, "لا يمكن نقل المجلد إلى أحد فروعه", "cycle");
        }
        const [parent] = await db
          .select({ id: folders.id })
          .from(folders)
          .where(and(eq(folders.id, parentId), eq(folders.userId, user.id)))
          .limit(1);
        if (!parent) throw new HttpError(404, "المجلد الأب غير موجود", "not_found");
      }
      patch.parentId = parentId;
    }

    const [updated] = await db
      .update(folders)
      .set(patch)
      .where(and(eq(folders.id, folderId), eq(folders.userId, user.id)))
      .returning();
    await logAudit(user.id, "folder.update", { folderId });
    return Response.json({ folder: serializeFolder(updated) });
  });
}

/** DELETE /api/folders/:id — recursive cascade + storage reclamation. */
export async function DELETE(request: Request, ctx: Ctx) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const { id } = await ctx.params;
    const folderId = asUuid(id);
    if (!folderId) throw new HttpError(400, "معرّف غير صالح", "bad_id");

    const tree = await collectFolderTree(user.id, folderId);
    if (tree.length === 0) {
      throw new HttpError(404, "المجلد غير موجود", "not_found");
    }

    const doomed = await db
      .select()
      .from(files)
      .where(and(eq(files.userId, user.id), eq(files.folderId, folderId)));

    // Objects living inside descendant folders (files are detached, not
    // cascade-deleted by the FK), so collect them too.
    const { filesInFolders } = await import("@/lib/server/vault");
    const nested = await filesInFolders(user.id, tree.slice(1));
    const all = [...doomed, ...nested];

    const driver = storage();
    let reclaimed = 0;
    for (const file of all) {
      await driver.deleteObject(file.s3StorageKey).catch(() => undefined);
      if (file.thumbnailKey) {
        await driver.deleteObject(file.thumbnailKey).catch(() => undefined);
      }
      reclaimed += Number(file.storedBytes);
    }

    await db
      .delete(files)
      .where(and(eq(files.userId, user.id), eq(files.folderId, folderId)));
    await db.delete(folders).where(eq(folders.id, folderId));
    await releaseStorage(user.id, reclaimed);
    await logAudit(user.id, "folder.delete", { folderId, reclaimed });

    return Response.json({ ok: true, deletedFiles: all.length, reclaimed });
  });
}
