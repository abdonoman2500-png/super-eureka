import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { uploadSessions, users } from "@/db/schema";
import { requireUnlockedVault } from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";
import { buildStorageKey, storage } from "@/lib/server/storage";
import { asUuid } from "@/lib/server/vault";
import { PART_SIZE } from "@/lib/shared/constants";
import type { InitUploadResponse } from "@/lib/shared/types";

interface InitBody {
  fileName?: string;
  size?: number;
  mimeType?: string;
  folderId?: string | null;
  kind?: "file" | "thumbnail";
  parentFileId?: string | null;
}

/**
 * POST /api/uploads
 * 1. Enforces the 1 TB quota (including AES-GCM per-part overhead).
 * 2. Mints a storage key and a batch of pre-signed part URLs so the device
 *    uploads ciphertext chunks directly to object storage — never via the API.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const body = await readJson<InitBody>(request);

    const fileName = assertString(body.fileName, "اسم الملف", { max: 255 })!;
    const mimeType = assertString(body.mimeType, "نوع الملف", { max: 140 })!;
    const size = Number(body.size);
    if (!Number.isFinite(size) || size < 0) {
      throw new HttpError(400, "حجم الملف غير صالح", "bad_size");
    }
    const kind = body.kind === "thumbnail" ? "thumbnail" : "file";
    const folderId = kind === "file" ? asUuid(body.folderId ?? null) : null;

    const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
    const projectedBytes = size + 28 * totalParts;

    const [quota] = await db
      .select({
        used: users.storageUsedBytes,
        limit: users.storageLimitBytes,
      })
      .from(users)
      .where(eq(users.id, user.id));
    if (Number(quota.used) + projectedBytes > Number(quota.limit)) {
      throw new HttpError(507, "تم استهلاك كامل المساحة (1 TB)", "quota_exceeded");
    }

    const driver = storage();
    const storageKey = buildStorageKey(user.id, kind === "thumbnail" ? "thumb" : "bin");
    const multipart = size > PART_SIZE;

    let providerUploadId: string | null = null;
    let partUrls: string[] = [];
    let putUrl: string | null = null;

    if (multipart) {
      providerUploadId = await driver.initMultipart(storageKey);
      partUrls = Array.from({ length: totalParts }, (_, index) =>
        driver.presignPut(storageKey, {
          partNumber: index + 1,
          uploadId: providerUploadId ?? undefined,
        }),
      );
    } else {
      putUrl = driver.presignPut(storageKey, { expiresSeconds: 3600 });
      partUrls = [putUrl];
    }

    const [session] = await db
      .insert(uploadSessions)
      .values({
        userId: user.id,
        folderId,
        fileName,
        mimeType,
        declaredBytes: size,
        storageKey,
        providerUploadId,
        partSize: PART_SIZE,
        totalParts,
        kind,
        parentFileId: asUuid(body.parentFileId ?? null),
      })
      .returning();

    const payload: InitUploadResponse = {
      uploadId: session.id,
      storageKey,
      partSize: PART_SIZE,
      totalParts,
      mode: multipart ? "multipart" : "single",
      putUrl,
      partUrls,
    };
    return Response.json(payload, { status: 201 });
  });
}

/** GET /api/uploads — resumable (pending) sessions for the device. */
export async function GET() {
  return handleRoute(async () => {
    const { user } = await requireUnlockedVault();
    const rows = await db
      .select()
      .from(uploadSessions)
      .where(
        and(eq(uploadSessions.userId, user.id), eq(uploadSessions.status, "pending")),
      )
      .orderBy(sql`${uploadSessions.createdAt} desc`)
      .limit(50);
    return Response.json({
      sessions: rows.map((row) => ({
        uploadId: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        declaredBytes: Number(row.declaredBytes),
        totalParts: row.totalParts,
        mode: row.providerUploadId ? "multipart" : "single",
        createdAt: row.createdAt.toISOString(),
      })),
    });
  });
}
