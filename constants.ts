/** Shared (client + server) protocol constants. */

/** Hard quota: 1 TB = 1,099,511,627,776 bytes. */
export const STORAGE_LIMIT_BYTES = 1_099_511_627_776;

/** Plaintext chunk size for multipart upload / per-chunk AES-GCM. */
export const PART_SIZE = 8 * 1024 * 1024;

/** Parallel upload streams from device to storage. */
export const PARALLEL_STREAMS = 4;

/** Local LRU thumbnail cache ceiling (bytes). */
export const THUMBNAIL_CACHE_LIMIT = 200 * 1024 * 1024;

/** PBKDF2 iterations for the client-side key-encryption-key. */
export const PBKDF2_ITERATIONS = 310_000;

/** AES-GCM overhead per encrypted chunk: 12 byte IV + 16 byte tag. */
export const GCM_OVERHEAD_BYTES = 28;

export const ACCESS_TOKEN_COOKIE = "nv_at";
export const REFRESH_TOKEN_COOKIE = "nv_rt";
export const UNLOCK_TOKEN_COOKIE = "nv_unlock";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const UNLOCK_TOKEN_TTL_SECONDS = 30 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}
