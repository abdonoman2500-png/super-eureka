"use client";

import { useEffect, useRef, useState } from "react";
import { downloadFile, loadMediaBlob } from "@/lib/client/media";
import { formatBytes } from "@/lib/shared/constants";
import type { FileDto } from "@/lib/shared/types";

interface Props {
  file: FileDto;
  dek: CryptoKey;
  onClose: () => void;
}

/**
 * Streams the ciphertext over the pre-signed URL, decrypts it progressively
 * in memory and renders it through a revocable blob URL. Nothing touches the
 * device filesystem.
 */
export default function PreviewModal({ file, dek, onClose }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setProgress(0);
    setError(null);
    loadMediaBlob(dek, file, (loaded, total) =>
      setProgress(total > 0 ? Math.round((loaded / total) * 100) : 0),
    )
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        urlRef.current = objectUrl;
        setUrl(objectUrl);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [dek, file]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-vault-950/85 p-4 backdrop-blur"
      onClick={onClose}
    >
      <div
        className="glass animate-float-up max-h-[92vh] w-full max-w-4xl overflow-auto rounded-3xl p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">{file.fileName}</h2>
            <p className="mt-1 text-xs text-vault-300">
              {formatBytes(file.fileSizeBytes)} · {file.mimeType} ·{" "}
              <span className="text-accent">{file.encryption}</span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => downloadFile(dek, file)}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-bold text-vault-950"
            >
              تنزيل مؤقت
            </button>
            <button
              onClick={onClose}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm text-vault-200 hover:bg-white/5"
            >
              إغلاق
            </button>
          </div>
        </div>

        <div className="mt-5 grid min-h-[300px] place-items-center overflow-hidden rounded-2xl bg-vault-950/60">
          {error ? (
            <p className="p-8 text-center text-sm text-red-300">{error}</p>
          ) : !url ? (
            <div className="w-full px-8 text-center">
              <p className="text-sm text-vault-300">
                جارٍ فك التشفير في الذاكرة… {progress}%
              </p>
              <div className="mx-auto mt-4 h-2 w-64 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-l from-accent to-vault-400 transition-all"
                  style={{ width: `${Math.max(4, progress)}%` }}
                />
              </div>
            </div>
          ) : file.mimeType.startsWith("image/") ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt={file.fileName} className="max-h-[70vh] w-auto" />
          ) : file.mimeType.startsWith("video/") ? (
            <video src={url} controls autoPlay className="max-h-[70vh] w-full" />
          ) : file.mimeType.startsWith("audio/") ? (
            <audio src={url} controls className="w-full px-6" />
          ) : (
            <p className="p-8 text-sm text-vault-300">
              معاينة هذا النوع غير متاحة — استخدم التنزيل المؤقت.
            </p>
          )}
        </div>
        <p className="mt-3 text-center text-[11px] text-vault-400">
          يُفك التشفير في ذاكرة الوصول العشوائي فقط، ويُبطَل الرابط فور الإغلاق — لا
          يُكتب أي بايت على مساحة الجهاز.
        </p>
      </div>
    </div>
  );
}
