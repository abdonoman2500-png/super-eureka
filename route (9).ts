import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  hashSecret,
  issueSession,
  logAudit,
  persistAuthCookies,
} from "@/lib/server/auth";
import { HttpError, assertString, handleRoute, readJson } from "@/lib/server/http";
import { publicUser } from "@/lib/server/serialize";

interface RegisterBody {
  email?: string;
  password?: string;
  pin?: string;
  displayName?: string;
  keyWrapSalt?: string;
  encryptedKeyBlob?: string;
  keyWrapIv?: string;
}

/**
 * POST /api/auth/register
 * Email + password (bcrypt) + 6-digit PIN (salted hash).
 * The wrapped master key material is produced on the device — the server only
 * ever stores ciphertext and can never derive the encryption key.
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = await readJson<RegisterBody>(request);

    const email = assertString(body.email, "البريد الإلكتروني", {
      min: 5,
      max: 255,
    })!
      .toLowerCase();
    const password = assertString(body.password, "كلمة المرور", {
      min: 8,
      max: 200,
    })!;
    const pin = assertString(body.pin, "رمز الأمان", { min: 4, max: 6 })!;
    const keyWrapSalt = assertString(body.keyWrapSalt, "ملح التشفير")!;
    const encryptedKeyBlob = assertString(body.encryptedKeyBlob, "المفتاح المشفر")!;
    const keyWrapIv = assertString(body.keyWrapIv, "متجه التهيئة")!;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new HttpError(400, "البريد الإلكتروني غير صالح", "bad_email");
    }
    if (!/^\d{4,6}$/.test(pin)) {
      throw new HttpError(400, "رمز الأمان يجب أن يكون 4 إلى 6 أرقام", "bad_pin");
    }

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) {
      throw new HttpError(409, "هذا البريد الإلكتروني مسجل مسبقاً", "email_taken");
    }

    const [passwordHash, pinHash] = await Promise.all([
      hashSecret(password),
      hashSecret(pin),
    ]);

    const [created] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        pinHash,
        displayName: assertString(body.displayName, "الاسم", {
          optional: true,
          max: 120,
        }),
        keyWrapSalt,
        encryptedKeyBlob,
        keyWrapIv,
      })
      .returning();

    const tokens = await issueSession(
      created.id,
      request.headers.get("user-agent"),
    );
    await persistAuthCookies(tokens);
    await logAudit(created.id, "auth.register", { email });

    return Response.json({ user: publicUser(created) }, { status: 201 });
  });
}
