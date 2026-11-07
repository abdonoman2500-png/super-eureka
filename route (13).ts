import { HttpError, handleRoute } from "@/lib/server/http";
import { storage } from "@/lib/server/storage";
import { verifyPayload } from "@/lib/server/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StorageToken {
  k: string;
  m: string;
  exp: number;
}

function requireToken(request: Request, mode: string): string {
  const token = new URL(request.url).searchParams.get("token");
  const payload = verifyPayload<StorageToken>(token);
  if (!payload || payload.m !== mode || typeof payload.k !== "string") {
    throw new HttpError(403, "رابط التخزين غير صالح أو منتهي الصلاحية", "bad_presign");
  }
  return payload.k;
}

function parseRange(header: string | null, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  let start = rawStart === "" ? 0 : Number(rawStart);
  let end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (rawStart === "" && rawEnd !== "") {
    start = Math.max(0, size - Number(rawEnd));
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  if (start > end || start < 0) return null;
  return { start, end };
}

/**
 * PUT /api/storage/object?token=...
 * Pre-signed direct write. The API only relays bytes to the storage driver —
 * no metadata processing, no buffering of the whole object in memory.
 */
export async function PUT(request: Request) {
  return handleRoute(async () => {
    const key = requireToken(request, "object-put");
    if (!request.body) {
      throw new HttpError(400, "جسم الطلب فارغ", "empty_body");
    }
    const size = await storage().putObject(key, request.body);
    return new Response(null, {
      status: 200,
      headers: { etag: `"${size}"`, "x-stored-bytes": String(size) },
    });
  });
}

/**
 * GET /api/storage/object?token=...
 * Pre-signed direct read with full HTTP Range support so media can be
 * streamed progressively instead of being downloaded to device storage.
 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const key = requireToken(request, "object-get");
    const driver = storage();
    const total = await driver.statObject(key);
    if (total === null) {
      return Response.json({ error: "العنصر غير موجود" }, { status: 404 });
    }

    const range = parseRange(request.headers.get("range"), total);
    const result = await driver.getObject(key, range ?? undefined);
    if (!result) {
      return Response.json({ error: "فشل قراءة العنصر" }, { status: 404 });
    }

    const headers = new Headers({
      "content-type": "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=0, no-store",
      "content-length": String(result.size),
      "x-total-bytes": String(total),
    });

    if (range) {
      headers.set("content-range", `bytes ${range.start}-${range.end}/${total}`);
      return new Response(result.stream, { status: 206, headers });
    }
    return new Response(result.stream, { status: 200, headers });
  });
}
