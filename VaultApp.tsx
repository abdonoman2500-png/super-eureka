"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import { cacheStats, purgeCache } from "@/lib/client/cache";
import { loadThumbnail } from "@/lib/client/media";
import { startUpload, type UploadHandle, type UploadProgress } from "@/lib/client/uploader";
import { getDek, setDek } from "@/lib/client/session";
import { formatBytes, STORAGE_LIMIT_BYTES } from "@/lib/shared/constants";
import type { FileDto, VaultListing } from "@/lib/shared/types";
import PreviewModal from "./PreviewModal";
import UnlockGate from "./UnlockGate";

interface QueueItem {
  id: string;
  fileName: string;
  handle: UploadHandle;
  progress: UploadProgress;
}

export default function VaultApp() {
  const router = useRouter();
  const [phase, setPhase] = useState<"loading" | "locked" | "ready" | "anon">("loading");
  const [data, setData] = useState<VaultListing | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [preview, setPreview] = useState<FileDto | null>(null);
  const [cache, setCache] = useState({ entries: 0, bytes: 0, limit: 0 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const thumbsRef = useRef<Record<string, string>>({});

  const load = useCallback(
    async (params: { folderId?: string | null; q?: string; favorites?: boolean }) => {
      const search = new URLSearchParams();
      if (params.folderId) search.set("folderId", params.folderId);
      if (params.q) search.set("q", params.q);
      if (params.favorites) search.set("favorites", "1");
      try {
        const listing = await api<VaultListing>(`/api/vault?${search.toString()}`);
        setData(listing);
      } catch (error) {
        if (error instanceof ApiError && error.status === 423) setPhase("locked");
        else if (error instanceof ApiError && error.status === 401) setPhase("anon");
      }
    },
    [],
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const me = await api<{ user: unknown | null }>("/api/auth/me");
        if (!me.user) {
          setPhase("anon");
          return;
        }
        if (!getDek()) {
          setPhase("locked");
          return;
        }
        setPhase("ready");
      } catch {
        setPhase("anon");
      } finally {
        if (mounted) void 0;
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    void load({ folderId, q: query, favorites });
    void cacheStats().then(setCache);
  }, [phase, folderId, query, favorites, load]);

  useEffect(() => {
    return () => {
      Object.values(thumbsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  useEffect(() => {
    if (!data || !getDek()) return;
    const dek = getDek()!;
    let cancelled = false;
    (async () => {
      for (const file of data.files.slice(0, 60)) {
        if (cancelled) return;
        if (!file.thumbnailUrl || thumbsRef.current[file.id]) continue;
        const url = await loadThumbnail(dek, file).catch(() => null);
        if (url && !cancelled) {
          thumbsRef.current[file.id] = url;
          setThumbs((prev) => ({ ...prev, [file.id]: url }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  const usedPercent = useMemo(() => {
    if (!data) return 0;
    return Math.min(100, (data.user.storageUsedBytes / data.user.storageLimitBytes) * 100);
  }, [data]);

  const refreshCache = async () => setCache(await cacheStats());

  const enqueue = (files: FileList | File[]) => {
    const dek = getDek();
    if (!dek) return;
    Array.from(files).forEach((file) => {
      const item: QueueItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        fileName: file.name,
        handle: null as unknown as UploadHandle,
        progress: { uploaded: 0, total: file.size, speed: 0, status: "queued" },
      };
      const handle = startUpload(dek, file, folderId, (progress) => {
        setQueue((prev) =>
          prev.map((entry) => (entry.id === item.id ? { ...entry, progress } : entry)),
        );
      });
      item.handle = handle;
      setQueue((prev) => [...prev, item]);
      handle.promise
        .then(async (created) => {
          if (created) {
            await load({ folderId, q: query, favorites });
            await refreshCache();
          }
        })
        .catch((error: Error) => {
          setQueue((prev) =>
            prev.map((entry) =>
              entry.id === item.id
                ? {
                    ...entry,
                    progress: { ...entry.progress, status: "failed", error: error.message },
                  }
                : entry,
            ),
          );
        })
        .finally(() => {
          setTimeout(() => {
            setQueue((prev) => prev.filter((entry) => entry.id !== item.id));
          }, 4000);
        });
    });
  };

  const createFolder = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newFolder.trim()) return;
    setBusy(true);
    try {
      await api("/api/vault", {
        method: "POST",
        body: JSON.stringify({ name: newFolder.trim(), parentId: folderId }),
      });
      setNewFolder("");
      setShowFolderInput(false);
      await load({ folderId, q: query, favorites });
    } finally {
      setBusy(false);
    }
  };

  const mutateFile = async (file: FileDto, patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api(`/api/files/${file.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      await load({ folderId, q: query, favorites });
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async (file: FileDto) => {
    if (!confirm(`حذف «${file.fileName}» نهائياً؟`)) return;
    setBusy(true);
    try {
      await api(`/api/files/${file.id}`, { method: "DELETE" });
      await load({ folderId, q: query, favorites });
    } finally {
      setBusy(false);
    }
  };

  const removeFolder = async (id: string) => {
    if (!confirm("سيتم حذف المجلد وكل محتوياته. متابعة؟")) return;
    setBusy(true);
    try {
      await api(`/api/folders/${id}`, { method: "DELETE" });
      if (folderId === id) setFolderId(null);
      await load({ folderId: folderId === id ? null : folderId, q: query, favorites });
    } finally {
      setBusy(false);
    }
  };

  const lockVault = async () => {
    await api("/api/auth/lock", { method: "POST" }).catch(() => undefined);
    setDek(null);
    setThumbs({});
    thumbsRef.current = {};
    setPhase("locked");
  };

  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setDek(null);
    router.push("/");
  };

  if (phase === "loading") {
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="glass rounded-3xl px-8 py-6 text-center">
          <p className="text-sm text-vault-200">جارٍ تجهيز الخزنة…</p>
          <div className="mt-4 h-1 w-40 overflow-hidden rounded-full shimmer" />
        </div>
      </main>
    );
  }

  if (phase === "anon") {
    router.replace("/login");
    return (
      <main className="grid min-h-screen place-items-center text-sm text-vault-300">
        جارٍ تحويلك إلى صفحة الدخول…
      </main>
    );
  }

  if (phase === "locked") {
    return (
      <UnlockGate
        onUnlocked={() => {
          setPhase("ready");
        }}
      />
    );
  }

  const queueActive = queue.filter(
    (item) => item.progress.status !== "done" && item.progress.status !== "failed",
  );

  return (
    <main
      className="min-h-screen"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer?.files?.length) enqueue(event.dataTransfer.files);
      }}
    >
      <div
        className={`pointer-events-none fixed inset-0 z-40 border-4 border-dashed transition ${
          dragging ? "border-accent/70 bg-accent/5" : "border-transparent"
        }`}
      />

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-6 lg:grid-cols-[270px_1fr]">
        {/* Sidebar */}
        <aside className="glass h-fit rounded-3xl p-5">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-vault-500 to-accent text-lg">
              ☁️
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{data?.user.email ?? "…"}</p>
              <p className="text-[11px] text-vault-300">خزنة مشفّرة E2EE</p>
            </div>
          </div>

          <div className="mt-5">
            <div className="flex justify-between text-[11px] text-vault-300">
              <span>المساحة</span>
              <span>
                {formatBytes(data?.user.storageUsedBytes ?? 0)} /{" "}
                {formatBytes(STORAGE_LIMIT_BYTES, 0)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-gradient-to-l from-accent to-vault-400"
                style={{ width: `${Math.max(0.6, usedPercent)}%` }}
              />
            </div>
          </div>

          <nav className="mt-6 space-y-1 text-sm">
            {[
              { key: "all", label: "كل الملفات", icon: "🗂️" },
              { key: "photos", label: "الصور", icon: "🖼️" },
              { key: "videos", label: "الفيديو", icon: "🎬" },
              { key: "favorites", label: "المفضلة", icon: "⭐" },
            ].map((item) => (
              <button
                key={item.key}
                onClick={() => {
                  setFavorites(item.key === "favorites");
                  if (item.key === "photos") setQuery(".jpg");
                  else if (item.key === "videos") setQuery(".mp4");
                  else setQuery("");
                }}
                className={`flex w-full items-center justify-between rounded-2xl px-3 py-2 transition hover:bg-white/5 ${
                  (item.key === "favorites" && favorites) ||
                  (item.key === "all" && !favorites && !query)
                    ? "bg-white/8 text-vault-100"
                    : "text-vault-300"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span>{item.icon}</span>
                  {item.label}
                </span>
                {item.key === "photos" && (
                  <span className="text-[11px] text-vault-400">{data?.stats.photos}</span>
                )}
                {item.key === "videos" && (
                  <span className="text-[11px] text-vault-400">{data?.stats.videos}</span>
                )}
              </button>
            ))}
          </nav>

          <div className="mt-6 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-vault-200">المجلدات</p>
              <button
                onClick={() => setShowFolderInput((value) => !value)}
                className="grid h-6 w-6 place-items-center rounded-lg bg-white/10 text-sm"
              >
                +
              </button>
            </div>
            {showFolderInput && (
              <form onSubmit={createFolder} className="mt-2 flex gap-2">
                <input
                  autoFocus
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  placeholder="اسم المجلد"
                  className="w-full rounded-xl border border-white/10 bg-vault-900/70 px-3 py-2 text-xs outline-none focus:border-accent/50"
                />
                <button className="rounded-xl bg-accent px-3 text-xs font-bold text-vault-950">
                  حفظ
                </button>
              </form>
            )}
            <div className="mt-3 space-y-1">
              <button
                onClick={() => {
                  setFolderId(null);
                  setFavorites(false);
                  setQuery("");
                }}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs transition hover:bg-white/5 ${
                  !folderId ? "bg-white/8 text-vault-100" : "text-vault-300"
                }`}
              >
                📁 الجذر
              </button>
              {data?.folders.map((folder) => (
                <div key={folder.id} className="group flex items-center gap-1">
                  <button
                    onClick={() => {
                      setFolderId(folder.id);
                      setFavorites(false);
                      setQuery("");
                    }}
                    className="flex-1 truncate rounded-xl px-3 py-2 text-right text-xs text-vault-300 transition hover:bg-white/5"
                  >
                    📁 {folder.name}
                  </button>
                  <button
                    onClick={() => removeFolder(folder.id)}
                    className="opacity-0 transition group-hover:opacity-100"
                    title="حذف المجلد"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 rounded-2xl bg-white/[0.03] p-3 text-[11px] text-vault-300">
            <p className="font-bold text-vault-200">كاش المصغرات (LRU)</p>
            <p className="mt-1">
              {formatBytes(cache.bytes)} من {formatBytes(cache.limit, 0)} · {cache.entries} عنصر
            </p>
            <button
              onClick={async () => {
                await purgeCache();
                await refreshCache();
                setThumbs({});
                thumbsRef.current = {};
              }}
              className="mt-2 rounded-lg border border-white/10 px-2 py-1 hover:bg-white/5"
            >
              تفريغ الكاش
            </button>
          </div>

          <div className="mt-5 space-y-2">
            <button
              onClick={lockVault}
              className="w-full rounded-2xl border border-white/10 py-2 text-xs text-vault-200 hover:bg-white/5"
            >
              🔒 قفل الخزنة
            </button>
            <button
              onClick={signOut}
              className="w-full rounded-2xl border border-white/10 py-2 text-xs text-vault-300 hover:bg-white/5"
            >
              تسجيل الخروج
            </button>
          </div>
        </aside>

        {/* Main panel */}
        <section className="space-y-5">
          <div className="glass flex flex-wrap items-center gap-3 rounded-3xl p-4">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ابحث في الخزنة…"
              className="min-w-[200px] flex-1 rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-2.5 text-sm outline-none focus:border-accent/50"
            />
            <button
              onClick={() => fileInput.current?.click()}
              className="rounded-2xl bg-accent px-5 py-2.5 text-sm font-bold text-vault-950 transition hover:brightness-110"
            >
              ⬆ رفع ملفات
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) enqueue(event.target.files);
                event.target.value = "";
              }}
            />
          </div>

          {message && (
            <p className="glass rounded-2xl px-4 py-3 text-sm text-accent">{message}</p>
          )}

          {queue.length > 0 && (
            <div className="glass space-y-2 rounded-3xl p-4">
              <p className="text-xs font-bold text-vault-200">
                قائمة الرفع · {queueActive.length} نشط
              </p>
              {queue.map((item) => {
                const percent = Math.round(
                  (item.progress.uploaded / Math.max(1, item.progress.total)) * 100,
                );
                return (
                  <div key={item.id} className="rounded-2xl bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate">{item.fileName}</span>
                      <span className="shrink-0 text-vault-300">
                        {percent}% ·{" "}
                        {item.progress.speed > 0
                          ? `${formatBytes(item.progress.speed)}/ث`
                          : "…"}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className={`h-full rounded-full transition-all ${
                          item.progress.status === "failed"
                            ? "bg-red-400"
                            : "bg-gradient-to-l from-accent to-vault-400"
                        }`}
                        style={{ width: `${Math.max(2, percent)}%` }}
                      />
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px]">
                      <span className="text-vault-400">
                        {
                          {
                            queued: "في الانتظار",
                            encrypting: "تشفير محلي",
                            uploading: "رفع متوازٍ (4 خيوط)",
                            paused: "متوقف مؤقتاً",
                            done: "تم",
                            failed: "فشل",
                          }[item.progress.status]
                        }
                      </span>
                      {item.progress.status === "uploading" && (
                        <>
                          <button
                            onClick={() => item.handle.pause()}
                            className="rounded-lg border border-white/10 px-2 py-0.5 hover:bg-white/5"
                          >
                            إيقاف مؤقت
                          </button>
                          <button
                            onClick={() => item.handle.cancel()}
                            className="rounded-lg border border-red-400/30 px-2 py-0.5 text-red-300 hover:bg-red-500/10"
                          >
                            إلغاء
                          </button>
                        </>
                      )}
                      {item.progress.status === "paused" && (
                        <button
                          onClick={() => item.handle.resume()}
                          className="rounded-lg border border-accent/40 px-2 py-0.5 text-accent hover:bg-accent/10"
                        >
                          استئناف
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {data && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-vault-300">
              {data.breadcrumbs.length === 0 && <span>الجذر</span>}
              {data.breadcrumbs.map((crumb, index) => (
                <span key={crumb.id} className="flex items-center gap-2">
                  {index > 0 && <span className="text-vault-500">/</span>}
                  <button
                    onClick={() => setFolderId(crumb.id)}
                    className={
                      index === data.breadcrumbs.length - 1
                        ? "text-vault-100"
                        : "hover:text-accent"
                    }
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
              <span className="text-vault-500">·</span>
              <span>{data.files.length} ملف</span>
              <span className="text-vault-500">·</span>
              <span>{data.folders.length} مجلد فرعي</span>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data?.folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => {
                  setFolderId(folder.id);
                  setQuery("");
                  setFavorites(false);
                }}
                className="glass group flex items-center gap-3 rounded-3xl p-4 text-right transition hover:bg-white/8"
              >
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-vault-700 text-xl">
                  📁
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold">{folder.name}</span>
                  <span className="block text-[11px] text-vault-300">مجلد</span>
                </span>
                <span
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeFolder(folder.id);
                  }}
                  className="opacity-0 transition group-hover:opacity-100"
                >
                  🗑️
                </span>
              </button>
            ))}

            {data?.files.map((file) => (
              <article
                key={file.id}
                className="glass group overflow-hidden rounded-3xl transition hover:bg-white/8"
              >
                <button
                  onClick={() => setPreview(file)}
                  className="block h-36 w-full bg-vault-950/60"
                >
                  {thumbs[file.id] ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumbs[file.id]}
                      alt={file.fileName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="grid h-full w-full place-items-center text-3xl">
                      {file.mimeType.startsWith("video/")
                        ? "🎬"
                        : file.mimeType.startsWith("image/")
                          ? "🖼️"
                          : file.mimeType.startsWith("audio/")
                            ? "🎵"
                            : "📄"}
                    </span>
                  )}
                </button>
                <div className="p-4">
                  <p className="truncate text-sm font-bold">{file.fileName}</p>
                  <p className="mt-1 text-[11px] text-vault-300">
                    {formatBytes(file.fileSizeBytes)} ·{" "}
                    {new Date(file.createdAt).toLocaleDateString("ar")}
                  </p>
                  <div className="mt-3 flex items-center gap-1 text-xs">
                    <button
                      onClick={() =>
                        mutateFile(file, { isFavorite: !file.isFavorite })
                      }
                      title="مفضلة"
                    >
                      {file.isFavorite ? "⭐" : "☆"}
                    </button>
                    <button
                      onClick={() => {
                        const name = prompt("الاسم الجديد", file.fileName);
                        if (name) void mutateFile(file, { fileName: name });
                      }}
                      title="إعادة تسمية"
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => {
                        const target = prompt(
                          "معرّف المجلد الهدف (اتركه فارغاً للجذر)",
                          file.folderId ?? "",
                        );
                        if (target !== null)
                          void mutateFile(file, { folderId: target || null });
                      }}
                      title="نقل"
                    >
                      📤
                    </button>
                    <button
                      onClick={() => removeFile(file)}
                      title="حذف"
                      className="text-red-300"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>

          {data && data.files.length === 0 && data.folders.length === 0 && (
            <div className="glass grid place-items-center rounded-3xl p-12 text-center">
              <span className="text-4xl">📥</span>
              <p className="mt-4 font-bold">اسحب ملفاتك إلى هنا</p>
              <p className="mt-2 max-w-sm text-sm text-vault-300">
                سيتم تشفيرها بـ AES-256-GCM على جهازك ثم رفعها مجزأةً عبر 4 خيوط مباشرة
                إلى التخزين السحابي.
              </p>
            </div>
          )}
        </section>
      </div>

      {preview && getDek() && (
        <PreviewModal file={preview} dek={getDek()!} onClose={() => setPreview(null)} />
      )}

      {busy && (
        <div className="fixed bottom-4 left-4 z-40 rounded-2xl bg-vault-800 px-4 py-2 text-xs text-vault-200">
          جارٍ التنفيذ…
        </div>
      )}
    </main>
  );
}
