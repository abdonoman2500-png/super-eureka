"use client";

/**
 * Zero-knowledge client crypto.
 *
 * Envelope design:
 *   DEK  : random AES-256-GCM key (encrypts every file chunk) — never leaves the device.
 *   KEK  : PBKDF2-SHA512(password ‖ PIN, server-stored random salt, 310k) — never transmitted.
 *   blob : AES-256-GCM(KEK, DEK) — the only thing the server persists.
 *   dev  : ECDH P-256 device key; wraps the DEK again so biometric unlock works
 *          without re-typing the password.
 */

import { PBKDF2_ITERATIONS } from "@/lib/shared/constants";

const AAD = new TextEncoder().encode("nimbusvault-chunk-v1");
const subtle = () => globalThis.crypto.subtle;

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function toB64url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function deriveKek(
  password: string,
  pin: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const base = await subtle().importKey(
    "raw",
    new TextEncoder().encode(`${password}:${pin}`),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-512",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function generateDek(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export async function exportDek(dek: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey("raw", dek));
}

export async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as unknown as BufferSource, { name: "AES-GCM" }, true, [
    "encrypt",
    "decrypt",
  ]);
}

export interface WrappedKey {
  iv: string;
  blob: string;
}

export async function wrapKey(
  kek: CryptoKey,
  dek: CryptoKey,
): Promise<WrappedKey> {
  const raw = await exportDek(dek);
  const iv = randomBytes(12);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: AAD as unknown as BufferSource },
    kek,
    raw as unknown as BufferSource,
  );
  return { iv: toB64url(iv), blob: toB64url(sealed) };
}

export async function unwrapKey(
  kek: CryptoKey,
  wrapped: WrappedKey,
): Promise<CryptoKey> {
  const raw = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: fromB64url(wrapped.iv) as unknown as BufferSource,
      additionalData: AAD as unknown as BufferSource,
    },
    kek,
    fromB64url(wrapped.blob) as unknown as BufferSource,
  );
  return importDek(new Uint8Array(raw));
}

/** Encrypts one chunk. Output layout: [12B IV][ciphertext+tag]. */
export async function encryptChunk(
  dek: CryptoKey,
  plaintext: ArrayBuffer,
): Promise<Uint8Array> {
  const iv = randomBytes(12);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: AAD as unknown as BufferSource },
    dek,
    plaintext,
  );
  const out = new Uint8Array(iv.length + sealed.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(sealed), iv.length);
  return out;
}

/** Decrypts a chunk produced by `encryptChunk`. */
export async function decryptChunk(
  dek: CryptoKey,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const iv = payload.subarray(0, 12);
  const sealed = payload.subarray(12);
  const plain = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: iv as unknown as BufferSource,
      additionalData: AAD as unknown as BufferSource,
    },
    dek,
    sealed as unknown as BufferSource,
  );
  return new Uint8Array(plain);
}

/**
 * Progressive decryption of a multi-part object. Yields plaintext chunks as
 * they arrive so media can be consumed while the rest is still downloading.
 */
export async function* decryptObjectStream(
  dek: CryptoKey,
  stream: ReadableStream<Uint8Array>,
  totalPlaintextBytes: number,
  partSize: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  const totalParts = Math.max(1, Math.ceil(totalPlaintextBytes / partSize));

  for (let partIndex = 0; partIndex < totalParts; partIndex += 1) {
    const isLast = partIndex === totalParts - 1;
    const plaintextLength = isLast
      ? totalPlaintextBytes - (totalParts - 1) * partSize
      : partSize;
    const sealedLength = plaintextLength + 28;

    while (buffer.length < sealedLength) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;
      }
    }
    if (buffer.length < sealedLength) {
      throw new Error("تعذر فك التشفير: البيانات غير مكتملة");
    }
    const sealed = buffer.subarray(0, sealedLength);
    buffer = buffer.subarray(sealedLength);
    yield await decryptChunk(dek, sealed);
  }
  await reader.cancel().catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Device credential (biometric unlock)
 * ------------------------------------------------------------------ */

export interface DeviceCredential {
  credentialId: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

export interface StoredDeviceCredential {
  credentialId: string;
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
}

export async function createDeviceCredential(): Promise<StoredDeviceCredential> {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
  ]);
  const credentialId = toB64url(randomBytes(24));
  return {
    credentialId,
    privateKeyJwk: await subtle().exportKey("jwk", pair.privateKey),
    publicKeyJwk: await subtle().exportKey("jwk", pair.publicKey),
  };
}

export async function restoreDeviceCredential(
  stored: StoredDeviceCredential,
): Promise<DeviceCredential> {
  const privateKey = await subtle().importKey(
    "jwk",
    stored.privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey"],
  );
  const publicKey = await subtle().importKey(
    "jwk",
    stored.publicKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return { credentialId: stored.credentialId, privateKey, publicKey };
}

export async function exportPublicJwk(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey("jwk", key);
}

async function deriveDeviceAes(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
): Promise<CryptoKey> {
  return subtle().deriveKey(
    { name: "ECDH", public: publicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals a server nonce using the ECDH shared secret with the server key. */
export async function sealChallenge(
  privateKey: CryptoKey,
  ephemeralPublicKeySpki: string,
  nonce: string,
): Promise<WrappedKey> {
  const serverKey = await subtle().importKey(
    "spki",
    fromB64url(ephemeralPublicKeySpki) as unknown as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const aes = await deriveDeviceAes(privateKey, serverKey);
  const iv = randomBytes(12);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    aes,
    new TextEncoder().encode(nonce),
  );
  return { iv: toB64url(iv), blob: toB64url(sealed) };
}

/** Wraps the DEK with the device key so biometric unlock can restore it. */
export async function wrapDekForDevice(
  credential: DeviceCredential,
  dek: CryptoKey,
): Promise<WrappedKey> {
  const aes = await deriveDeviceAes(credential.privateKey, credential.publicKey);
  const raw = await exportDek(dek);
  const iv = randomBytes(12);
  const sealed = await subtle().encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    aes,
    raw as unknown as BufferSource,
  );
  return { iv: toB64url(iv), blob: toB64url(sealed) };
}

export async function unwrapDekForDevice(
  credential: DeviceCredential,
  wrapped: WrappedKey,
): Promise<CryptoKey> {
  const aes = await deriveDeviceAes(credential.privateKey, credential.publicKey);
  const raw = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: fromB64url(wrapped.iv) as unknown as BufferSource,
    },
    aes,
    fromB64url(wrapped.blob) as unknown as BufferSource,
  );
  return importDek(new Uint8Array(raw));
}

/** Downscales an image to a tiny encrypted WebP thumbnail. */
export async function makeEncryptedThumbnail(
  dek: CryptoKey,
  file: File,
  maxSize = 512,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    const scale = Math.min(1, maxSize / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const webp = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/webp", 0.72),
    );
    if (!webp) return null;
    const sealed = await encryptChunk(dek, await webp.arrayBuffer());
    return {
      blob: new Blob([sealed as unknown as BlobPart], {
        type: "application/octet-stream",
      }),
      width: originalWidth,
      height: originalHeight,
    };
  } catch {
    return null;
  }
}
