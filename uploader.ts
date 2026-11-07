"use client";

import {
  encryptChunk,
  makeEncryptedThumbnail,
} from "@/lib/client/crypto";
import { api } from "@/lib/client/api";
import {
  PARALLEL_STREAMS,
  PART_SIZE,
} from "@/lib/shared/constants";
import type { FileDto, InitUploadResponse } from "@/lib/shared/types";

export interface UploadProgress {
  uploaded: number;
  total: number;
  speed: number;
  status: "queued" | "encrypting" | "uploading" | "paused" | "done" | "failed";
}

export interface UploadHandle {
  id: string;
  fileName: string;
  promise: Promise<FileDto | null>;
  pause(): void;
  resume(): void;
  cancel(): void;
}

interface PartResult {
  partNumber: number;
  etag: string;
  size: number;
}

async function putChunk(
  url: string,
  body: Blob,
): Promise<PartResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "PUT",
        body,
        credentials: "omit",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const etag =
        response.headers.get("etag") ??
        response.headers.get("ETag") ??
        `part-${Date.now()}`;
      return {
        partNumber: 0,
        etag: etag.replace(/"/g, ""),
        size: body.size,
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("upload failed");
}

/**
 * Chunked, parallel, resumable, client-side-encrypted upload.
 *
 *   1. POST /api/uploads        → quota check + pre-signed part URLs
 *   2. AES-256-GCM seal chunk    (device only)
 *   3. PUT chunk → storage       (4 parallel streams, retried per chunk)
 *   4. POST /complete            → metadata commit + atomic quota increment
 */
export function startUpload(
  dek: CryptoKey,
  file: File,
  folderId: string | null,
  onProgress: (progress: UploadProgress) => void,
): UploadHandle {
  const id = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let paused = false;
  let cancelled = false;
  let resumeWaiters: (() => void)[] = [];
  let uploaded = 0;
  const startedAt = Date.now();
  let speed = 0;

  const waitWhilePaused = () =>
    new Promise<void>((resolve) => {
      if (!paused) resolve();
      else resumeWaiters.push(resolve);
    });

  const promise = (async (): Promise<FileDto | null> => {
    onProgress({ uploaded: 0, total: file.size, speed: 0, status: "encrypting" });

    const init = await api<InitUploadResponse>("/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        size: file.size,
        mimeType: file.type || "application/octet-stream",
        folderId,
      }),
    });

    const totalParts = init.totalParts;
    const results = new Map<number, PartResult>();
    let nextIndex = 0;

    const uploadPart = async (partNumber: number) => {
      const start = (partNumber - 1) * PART_SIZE;
      const end = Math.min(file.size, start + PART_SIZE);
      const plain = await file.slice(start, end).arrayBuffer();
      const sealed = await encryptChunk(dek, plain);
      if (cancelled) throw new Error("cancelled");
      await waitWhilePaused();
      const blob = new Blob([sealed as unknown as BlobPart], {
        type: "application/octet-stream",
      });
      const url = init.mode === "single" ? init.putUrl! : init.partUrls[partNumber - 1];
      const result = await putChunk(url, blob);
      results.set(partNumber, { ...result, partNumber });
      uploaded += end - start;
      const elapsed = (Date.now() - startedAt) / 1000;
      speed = elapsed > 0 ? uploaded / elapsed : 0;
      onProgress({
        uploaded,
        total: file.size,
        speed,
        status: paused ? "paused" : "uploading",
      });
    };

    const worker = async () => {
      while (!cancelled) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= totalParts) return;
        await uploadPart(index + 1);
      }
    };

    onProgress({ uploaded: 0, total: file.size, speed: 0, status: "uploading" });
    const workers = Array.from(
      { length: Math.min(PARALLEL_STREAMS, totalParts) },
      () => worker(),
    );
    await Promise.all(workers);
    if (cancelled) {
      await api(`/api/uploads/${init.uploadId}/abort`, { method: "POST" }).catch(
        () => undefined,
      );
      return null;
    }

    const thumbnail = await makeEncryptedThumbnail(dek, file);
    const complete = await api<{ file: FileDto | null }>(
      `/api/uploads/${init.uploadId}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          parts: [...results.values()].sort((a, b) => a.partNumber - b.partNumber),
          width: thumbnail?.width,
          height: thumbnail?.height,
        }),
      },
    );

    if (thumbnail && complete.file) {
      const thumbInit = await api<InitUploadResponse>("/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          fileName: `${file.name}.thumb`,
          size: thumbnail.blob.size,
          mimeType: "image/webp",
          kind: "thumbnail",
          parentFileId: complete.file.id,
        }),
      });
      const part = await putChunk(
        thumbInit.putUrl ?? thumbInit.partUrls[0],
        thumbnail.blob,
      );
      await api(`/api/uploads/${thumbInit.uploadId}/complete`, {
        method: "POST",
        body: JSON.stringify({ parts: [{ ...part, partNumber: 1 }] }),
      });
    }

    onProgress({ uploaded: file.size, total: file.size, speed, status: "done" });
    return complete.file;
  })();

  return {
    id,
    fileName: file.name,
    promise,
    pause() {
      paused = true;
      onProgress({ uploaded, total: file.size, speed, status: "paused" });
    },
    resume() {
      paused = false;
      resumeWaiters.forEach((resolve) => resolve());
      resumeWaiters = [];
      onProgress({ uploaded, total: file.size, speed, status: "uploading" });
    },
    cancel() {
      cancelled = true;
      paused = false;
      resumeWaiters.forEach((resolve) => resolve());
      resumeWaiters = [];
    },
  };
}
