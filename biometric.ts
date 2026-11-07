import crypto from "node:crypto";
import { HttpError } from "./http";

export interface PublicKeyJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

export function assertPublicKeyJwk(value: unknown): PublicKeyJwk {
  const jwk = value as PublicKeyJwk;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new HttpError(400, "مفتاح الجهاز غير صالح (متوقع ECDH P-256)", "bad_jwk");
  }
  return jwk;
}

/**
 * Generates an ephemeral ECDH P-256 pair for a proof-of-possession round.
 * Only the private half (PKCS8 DER, base64url) + nonce are persisted briefly.
 */
export function createEphemeralChallenge() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const ephemeralPublicKey = publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  const ephemeralPrivateKey = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64url");
  const nonce = crypto.randomBytes(32).toString("base64url");
  return { ephemeralPublicKey, ephemeralPrivateKey, nonce };
}

/**
 * Verifies the device's AES-GCM sealed challenge response.
 * The sealing key is the raw ECDH shared secret, matching WebCrypto's
 * `deriveKey({ name: "ECDH" }, ..., { name: "AES-GCM", length: 256 })`.
 */
export function verifyChallengeSeal(
  ephemeralPrivateKey: string,
  clientPublicJwk: PublicKeyJwk,
  iv: string,
  ciphertext: string,
  expectedNonce: string,
): boolean {
  try {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(ephemeralPrivateKey, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    const publicKey = crypto.createPublicKey({
      key: clientPublicJwk as unknown as crypto.JsonWebKey,
      format: "jwk",
    });
    const shared = crypto.diffieHellman({ privateKey, publicKey });
    const sealed = Buffer.from(ciphertext, "base64url");
    if (sealed.length < 16) return false;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      shared,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    ]);
    return plaintext.toString("utf8") === expectedNonce;
  } catch {
    return false;
  }
}
