"use client";

/**
 * Zero-footprint media cache.
 *
 * Nothing a user uploads is ever written to the device. The only thing kept
 * locally is a tiny decrypted WebP thumbnail in a bounded LRU cache (200 MB).
 * Once the ceiling is hit, the least-recently-used entries are evicted
 * automatically — the same policy the mobile client applies to its disk cache.
 */

import { THUMBNAIL_CACHE_LIMIT } from "@/lib/shared/constants";
import {
  cacheIndexAll,
  cacheIndexDelete,
  cacheIndexPut,
} from "./idb";

const CACHE_NAME = "nv-thumbs-v1";

async function cacheStore(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

export async function cacheStats(): Promise<{
  entries: number;
  bytes: number;
  limit: number;
}> {
  const entries = await cacheIndexAll();
  return {
    entries: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    limit: THUMBNAIL_CACHE_LIMIT,
  };
}

export async function getCachedBlob(key: string): Promise<Blob | null> {
  const store = await cacheStore();
  if (!store) return null;
  const hit = await store.match(key);
  if (!hit) return null;
  await cacheIndexPut({ key, bytes: (await hit.clone().blob()).size, lastAccess: Date.now() });
  return hit.blob();
}

export async function putCachedBlob(key: string, blob: Blob): Promise<void> {
  const store = await cacheStore();
  if (!store) return;
  await store.put(key, new Response(blob));
  await cacheIndexPut({ key, bytes: blob.size, lastAccess: Date.now() });
  await evictIfNeeded();
}

export async function evictIfNeeded(): Promise<number> {
  const entries = await cacheIndexAll();
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= THUMBNAIL_CACHE_LIMIT) return 0;

  const store = await cacheStore();
  const ordered = [...entries].sort((a, b) => a.lastAccess - b.lastAccess);
  let evicted = 0;
  for (const entry of ordered) {
    if (total <= THUMBNAIL_CACHE_LIMIT * 0.9) break;
    if (store) await store.delete(entry.key).catch(() => undefined);
    await cacheIndexDelete(entry.key);
    total -= entry.bytes;
    evicted += 1;
  }
  return evicted;
}

export async function purgeCache(): Promise<void> {
  const store = await cacheStore();
  if (store) await caches.delete(CACHE_NAME);
  for (const entry of await cacheIndexAll()) {
    await cacheIndexDelete(entry.key);
  }
}
