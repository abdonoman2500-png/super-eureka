import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { files, folders } from "@/db/schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUuid(value: string | null | undefined): string | null {
  if (!value) return null;
  return UUID_RE.test(value) ? value : null;
}

/** Recursive descent of a folder subtree (inclusive of the root). */
export async function collectFolderTree(
  userId: string,
  rootId: string,
): Promise<string[]> {
  const result = await db.execute(
    sql`WITH RECURSIVE tree AS (
          SELECT id FROM folders WHERE id = ${rootId}::uuid AND user_id = ${userId}::uuid
          UNION ALL
          SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
        ) SELECT id FROM tree`,
  );
  return (result.rows as { id: string }[]).map((row) => row.id);
}

export async function folderBelongsToUser(
  userId: string,
  folderId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)))
    .limit(1);
  return Boolean(row);
}

export async function filesInFolders(userId: string, folderIds: string[]) {
  if (folderIds.length === 0) return [];
  return db
    .select()
    .from(files)
    .where(and(eq(files.userId, userId), inArray(files.folderId, folderIds)));
}

/** Depth-first folder tree for the sidebar. */
export async function loadFolderTree(userId: string) {
  const rows = await db
    .select()
    .from(folders)
    .where(eq(folders.userId, userId))
    .orderBy(folders.name);
  const byParent = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = row.parentId ?? "root";
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  return { rows, byParent };
}
