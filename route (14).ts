import { HttpError, handleRoute } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";
import { verifyPayload } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PartToken {
  k: string;
  m: string;
  p?: number;
  up?: string;
  exp: number;
}

/**
 * PUT /api/storage/part?token=...
 * One chunk of a multipart upload. Mirrors an S3 UploadPart pre-signed URL:
 * the response ETag is what the client commits back to the metadata API.
 */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const token = new URL(request.url).searchParams.get("token");
    const payload = verifyPayload<PartToken>(token);
    if (
      !payload ||
      payload.m !== "part-put" ||
      typeof payload.p !== "number" ||
      typeof payload.up !== "string" ||
      typeof payload.k !== "string"
    ) {
      throw new HttpError(403, "رابط الجزء غير صالح أو منتهي الصلاحية", "bad_presign");
    }
    if (!request.body) {
      throw new HttpError(400, "جسم الطلب فارغ", "empty_body");
    }

    const { etag, size } = await storage().putPart(
      payload.up,
      payload.p,
      request.body,
    );
    return new Response(null, {
      status: 200,
      headers: { etag: `"${etag}"`, "x-part-bytes": String(size) },
    });
  });
}
