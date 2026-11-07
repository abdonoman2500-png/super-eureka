import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deviceCredentials } from "@/db/schema";
import { getAuthContext } from "@/lib/server/auth";
import { handleRoute } from "@/lib/server/http";
import { publicUser } from "@/lib/server/serialize";
import { storage } from "@/lib/server/storage";
import { UNLOCK_TOKEN_COOKIE } from "@/lib/shared/constants";
import { verifyJwt } from "@/lib/server/tokens";

/** GET /api/auth/me — session probe used by the client bootstrap. */
export async function GET() {
  return handleRoute(async () => {
    const context = await getAuthContext();
    if (!context) return Response.json({ user: null }, { status: 200 });

    const store = await cookies();
    const unlock = verifyJwt(store.get(UNLOCK_TOKEN_COOKIE)?.value);
    const credentials = await db
      .select({ id: deviceCredentials.id })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.userId, context.user.id));

    return Response.json({
      user: publicUser(context.user),
      unlocked: Boolean(unlock && unlock.typ === "unlock" && unlock.sub === context.user.id),
      deviceCredentials: credentials.length,
      storageBackend: storage().label,
    });
  });
}
