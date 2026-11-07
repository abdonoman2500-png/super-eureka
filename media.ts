"use client";

import { api } from "@/lib/client/api";
import { getCachedBlob, putCachedBlob } from "@/lib/client/cache";
import { decryptChunk, decryptObjectStream } from "@/lib/client/crypto";
import { PART_SIZE } from "@/lib/shared/constants";
import type { FileDto } from "@/lib/shared/types";

/**
 * On-demand media access — nothing is written to device storage.
 * Bytes are fetched over the pre-signed URL, decrypted in memory and exposed
 * through a revocable blob URL (revoked as soon as the viewer closes).
 */

export async function loadThumbnail(
  dek: CryptoKey,
  file: FileDto,
): Promise<string | null> {
  if (!file.thumbnailUrl) return null;
  const key = `thumb:${file.id}`;
  const cached = await getCachedBlob(key);
  if (cached) return URL.createObjectURL(cached);
  try {
    const response = await fetch(file.thumbnailUrl, { credentials: "omit" });
    if (!response.ok) return null;
    const sealed = new Uint8Array(await response.arrayBuffer());
    const plain = await decryptChunk(dek, sealed);
    const blob = new Blob([plain as unknown as BlobPart], { type: "image/webp" });
    await putCachedBlob(key, blob);
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export async function loadMediaBlob(
  dek: CryptoKey,
  file: FileDto,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  const response = await fetch(file.downloadUrl, { credentials: "omit" });
  if (!response.ok || !response.body) {
    throw new Error("تعذر تحميل الملف المشفر");
  }
  const total = Number(response.headers.get("x-total-bytes") ?? file.storedBytes);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, total || loaded);
    }
  }
  const sealed = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    sealed.set(chunk, offset);
    offset += chunk.length;
  }
  const plain: Uint8Array[] = [];
  for await (const part of decryptObjectStream(
    dek,
    new Blob([sealed as unknown as BlobPart]).stream() as ReadableStream<Uint8Array>,
    file.fileSizeBytes,
    PART_SIZE,
  )) {
    plain.push(part);
  }
  return new Blob(plain as unknown as BlobPart[], { type: file.mimeType });
}

export async function downloadFile(dek: CryptoKey, file: FileDto) {
  const blob = await loadMediaBlob(dek, file);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function refreshVault(params: {
  folderId?: string | null;
  q?: string;
  favorites?: boolean;
}) {
  const search = new URLSearchParams();
  if (params.folderId) search.set("folderId", params.folderId);
  if (params.q) search.set("q", params.q);
  if (params.favorites) search.set("favorites", "1");
  return api(`/api/vault?${search.toString()}`);
}
