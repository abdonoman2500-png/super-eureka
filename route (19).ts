import { requireAuth } from "@/lib/server/auth";
import { handleRoute } from "@/lib/server/http";

/**
 * GET /api/vault/key
 * Returns the *wrapped* master key ciphertext. The server cannot decrypt it:
 * the KEK is derived on-device from password + PIN via PBKDF2.
 */
export async function GET() {
  return handleRoute(async () => {
    const { user } = await requireAuth();
    return Response.json({
      keyWrapSalt: user.keyWrapSalt,
      encryptedKeyBlob: user.encryptedKeyBlob,
      keyWrapIv: user.keyWrapIv,
      algorithm: "PBKDF2-SHA512 → AES-256-GCM",
    });
  });
}
