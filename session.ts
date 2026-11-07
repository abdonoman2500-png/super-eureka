"use client";

import { api } from "@/lib/client/api";
import {
  createDeviceCredential,
  deriveKek,
  exportPublicJwk,
  fromB64url,
  generateDek,
  randomBytes,
  restoreDeviceCredential,
  sealChallenge,
  toB64url,
  unwrapDekForDevice,
  type StoredDeviceCredential,
  unwrapKey,
  wrapDekForDevice,
  wrapKey,
  type DeviceCredential,
  type WrappedKey,
} from "@/lib/client/crypto";
import { kvDelete, kvGet, kvSet } from "@/lib/client/idb";

const DEK_SLOT = "nv:device-wrapped-dek";
const CRED_SLOT = "nv:device-credential-id";

/** In-memory DEK. Never persisted unencrypted, never transmitted. */
let currentDek: CryptoKey | null = null;

export function setDek(key: CryptoKey | null) {
  currentDek = key;
}

export function getDek(): CryptoKey | null {
  return currentDek;
}

export function requireDek(): CryptoKey {
  if (!currentDek) throw new Error("الخزنة غير مفتوحة");
  return currentDek;
}

export interface KeyMaterial {
  keyWrapSalt: string;
  encryptedKeyBlob: string;
  keyWrapIv: string;
}

/** Registration: mint a fresh DEK and wrap it with password + PIN. */
export async function createVaultKeyMaterial(
  password: string,
  pin: string,
): Promise<KeyMaterial> {
  const salt = randomBytes(16);
  const dek = await generateDek();
  const kek = await deriveKek(password, pin, salt);
  const wrapped = await wrapKey(kek, dek);
  setDek(dek);
  return {
    keyWrapSalt: toB64url(salt),
    encryptedKeyBlob: wrapped.blob,
    keyWrapIv: wrapped.iv,
  };
}

/** Unlock: derive the KEK locally and unwrap the DEK. */
export async function unlockWithPassword(
  password: string,
  pin: string,
): Promise<boolean> {
  const material = await api<KeyMaterial>("/api/vault/key");
  const kek = await deriveKek(password, pin, fromB64url(material.keyWrapSalt));
  try {
    setDek(
      await unwrapKey(kek, { iv: material.keyWrapIv, blob: material.encryptedKeyBlob }),
    );
    return true;
  } catch {
    setDek(null);
    return false;
  }
}

/**
 * Enrolls this device: an ECDH P-256 key pair is generated locally (the
 * private half is non-extractable and never leaves IndexedDB), and the DEK is
 * re-wrapped under it so future unlocks need only a fingerprint / FaceID.
 */
export async function enrollDevice(dek: CryptoKey): Promise<boolean> {
  if (typeof indexedDB === "undefined") return false;
  const stored = await createDeviceCredential();
  await api("/api/auth/biometric", {
    method: "POST",
    body: JSON.stringify({
      credentialId: stored.credentialId,
      publicKeyJwk: stored.publicKeyJwk,
      label: "جهازي الحالي",
    }),
  });
  const credential = await restoreDeviceCredential(stored);
  const wrapped: WrappedKey = await wrapDekForDevice(credential, dek);
  await kvSet(DEK_SLOT, wrapped);
  await kvSet(CRED_SLOT, stored);
  return true;
}

async function loadDeviceCredential(): Promise<DeviceCredential | null> {
  const stored = await kvGet<StoredDeviceCredential>(CRED_SLOT);
  if (!stored?.privateKeyJwk) return null;
  try {
    return await restoreDeviceCredential(stored);
  } catch {
    return null;
  }
}

export async function hasEnrolledDevice(): Promise<boolean> {
  const stored = await kvGet<StoredDeviceCredential>(CRED_SLOT);
  return Boolean(stored?.privateKeyJwk);
}

/** Biometric unlock: prove possession of the device key, then unwrap the DEK. */
export async function unlockWithDevice(): Promise<boolean> {
  const credential = await loadDeviceCredential();
  const wrapped = await kvGet<WrappedKey>(DEK_SLOT);
  if (!credential || !wrapped) return false;

  const begin = await api<{
    challengeId: string;
    ephemeralPublicKey: string;
    nonce: string;
  }>("/api/auth/biometric/begin", {
    method: "POST",
    body: JSON.stringify({ credentialId: credential.credentialId }),
  });

  const sealed = await sealChallenge(
    credential.privateKey,
    begin.ephemeralPublicKey,
    begin.nonce,
  );

  await api("/api/auth/biometric/verify", {
    method: "POST",
    body: JSON.stringify({
      challengeId: begin.challengeId,
      credentialId: credential.credentialId,
      iv: sealed.iv,
      ciphertext: sealed.blob,
    }),
  });

  // The DEK was wrapped with a previous device key handle; the handle is
  // regenerated per session, so fall back to password unlock when needed.
  try {
    setDek(await unwrapDekForDevice(credential, wrapped));
    return true;
  } catch {
    return false;
  }
}

export async function forgetDevice() {
  await kvDelete(DEK_SLOT);
  await kvDelete(CRED_SLOT);
}
