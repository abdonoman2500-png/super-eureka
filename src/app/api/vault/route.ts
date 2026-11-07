import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { files, folders } from "@/db/schema";
import { requireUnlockedVault } from "@/lib/server/auth";
import { handleRoute } from "@/lib/server/http";
import { publicUser, serializeFile, serializeFolder } from "@/lib/server/serialize";
import { asUuid } from "@/lib/server/vault";
import type { VaultListing } from "@/lib/shared/types";

/**
 * GET /api/vault?folderId=&q=&favorites=1
 * Single round-trip folder navigation payload (metadata only — no bytes).
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const url = new URL(request.url);
    const folderId = asUuid(url.searchParams.get("folderId"));
    const query = url.searchParams.get("q")?.trim() ?? "";
    const favorites = url.searchParams.get("favorites") === "1";

    if (folderId) {
      const [folder] = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, folderId), eq(folders.userId, user.id)))
        .limit(1);
      if (!folder) {
        return Response.json({ error: "المجلد غير موجود" }, { status: 404 });
      }
    }

    const fileFilters = [eq(files.userId, user.id)];
    if (favorites) fileFilters.push(eq(files.isFavorite, true));
    if (query) fileFilters.push(ilike(files.fileName, `%${query}%`));
    if (!query && !favorites) {
      fileFilters.push(folderId ? eq(files.folderId, folderId) : isNull(files.folderId));
    }

    const [fileRows, folderRows, counts, totalFolders] = await Promise.all([
      db
        .select()
        .from(files)
        .where(and(...fileFilters))
        .orderBy(desc(files.createdAt))
        .limit(500),
      query || favorites
        ? Promise.resolve([] as (typeof folders.$inferSelect)[])
        : db
            .select()
            .from(folders)
            .where(
              and(
                eq(folders.userId, user.id),
                folderId ? eq(folders.parentId, folderId) : isNull(folders.parentId),
              ),
            )
            .orderBy(folders.name),
      db
        .select({
          photos: sql<number>`count(*) filter (where ${files.mimeType} like 'image/%')`,
          videos: sql<number>`count(*) filter (where ${files.mimeType} like 'video/%')`,
          total: sql<number>`count(*)`,
        })
        .from(files)
        .where(eq(files.userId, user.id)),
      db
        .select({ count: sql<number>`count(*)` })
        .from(folders)
        .where(eq(folders.userId, user.id)),
    ]);

    const breadcrumbs: { id: string; name: string }[] = [];
    let cursor = folderId;
    let guard = 0;
    while (cursor && guard++ < 32) {
      const [row] = await db
        .select()
        .from(folders)
        .where(and(eq(folders.id, cursor), eq(folders.userId, user.id)))
        .limit(1);
      if (!row) break;
      breadcrumbs.unshift({ id: row.id, name: row.name });
      cursor = row.parentId;
    }

    const payload: VaultListing = {
      folder: null,
      breadcrumbs,
      folders: folderRows.map(serializeFolder),
      files: fileRows.map(serializeFile),
      user: publicUser(user),
      stats: {
        totalFiles: Number(counts[0]?.total ?? 0),
        totalFolders: Number(totalFolders[0]?.count ?? 0),
        photos: Number(counts[0]?.photos ?? 0),
        videos: Number(counts[0]?.videos ?? 0),
      },
    };
    return Response.json(payload);
  });
}

/** GET /api/vault/tree — full folder tree for the sidebar. */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const body = (await request.json()) as {
      name?: string;
      parentId?: string | null;
      color?: string;
    };
    const name = (body.name ?? "").trim().slice(0, 255);
    if (!name) return Response.json({ error: "الاسم مطلوب" }, { status: 400 });
    const parentId = asUuid(body.parentId ?? null);
    if (parentId) {
      const [exists] = await db
        .select({ id: folders.id })
        .from(folders)
        .where(and(eq(folders.id, parentId), eq(folders.userId, user.id)))
        .limit(1);
      if (!exists) {
        return Response.json({ error: "المجلد الأب غير موجود" }, { status: 400 });
      }
    }

    const [row] = await db
      .insert(folders)
      .values({
        userId: user.id,
        parentId,
        name,
        color: body.color?.slice(0, 24) ?? "indigo",
      })
      .returning();
    return Response.json({ folder: serializeFolder(row) }, { status: 201 });
  });
}
