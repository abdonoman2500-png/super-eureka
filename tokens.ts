import crypto from "node:crypto";

/**
 * Server-side primitives: HS256 JWTs, HMAC-signed opaque payloads,
 * base64url helpers and random token generation.
 *
 * Kept dependency-free (pure node:crypto) so the API layer stays light.
 */

const encoder = new TextEncoder();

export function b64url(input: string | Uint8Array): string {
  const buf =
    typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64urlJson(value: string): unknown {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

export function fromB64url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
    "base64",
  );
}

export function authSecret(): string {
  return (
    process.env.AUTH_SECRET ??
    process.env.JWT_SECRET ??
    "nimbusvault-development-secret-change-me"
  );
}

export function storageSigningSecret(): string {
  return process.env.STORAGE_SIGNING_SECRET ?? authSecret();
}

export function hmac(secret: string, data: string): Buffer {
  return crypto.createHmac("sha256", secret).update(data, "utf8").digest();
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Uint8Array): string {
  return crypto
    .createHash("sha256")
    .update(typeof input === "string" ? encoder.encode(input) : input)
    .digest("hex");
}

export interface JwtPayload {
  sub: string;
  typ: "access" | "unlock";
  sid?: string;
  iat: number;
  exp: number;
}

export function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  ttlSeconds: number,
  secret = authSecret(),
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(
    JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }),
  );
  const signature = b64url(hmac(secret, `${header}.${body}`));
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token: string | undefined | null): JwtPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expected = b64url(hmac(authSecret(), `${header}.${body}`));
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const payload = b64urlJson(body) as JwtPayload;
    if (typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.sub !== "string" || payload.sub.length === 0) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Sign an arbitrary JSON payload into a tamper-proof opaque token. */
export function signPayload(payload: Record<string, unknown>): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(hmac(storageSigningSecret(), body))}`;
}

export function verifyPayload<T extends object>(
  token: string | null | undefined,
): T | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = b64url(hmac(storageSigningSecret(), body));
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    const payload = b64urlJson(body) as T & { exp?: number };
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
