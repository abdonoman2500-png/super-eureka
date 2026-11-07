"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import {
  hasEnrolledDevice,
  unlockWithDevice,
  unlockWithPassword,
} from "@/lib/client/session";

/**
 * App-lock screen. Mirrors the mobile flow: a 4-6 digit PIN (verified against
 * the server-side salted hash) plus a biometric / device-key shortcut that
 * performs an ECDH proof-of-possession round before unlocking.
 */
export default function UnlockGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometric, setBiometric] = useState(false);

  useEffect(() => {
    hasEnrolledDevice().then(setBiometric).catch(() => setBiometric(false));
  }, []);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/pin", { method: "POST", body: JSON.stringify({ pin }) });
      const ok = await unlockWithPassword(password, pin);
      if (!ok) throw new Error("فشل فك غلاف مفتاح التشفير — تحقق من البيانات");
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unlockBiometric = async () => {
    setError(null);
    setBusy(true);
    try {
      const ok = await unlockWithDevice();
      if (!ok) {
        setError("تعذر الفتح بمفتاح الجهاز — استخدم كلمة المرور والرمز");
        return;
      }
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-5">
      <div className="glass animate-float-up rounded-3xl p-7 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-3xl bg-vault-800 text-3xl">
          🔒
        </div>
        <h1 className="mt-5 text-xl font-black">الخزنة مقفلة</h1>
        <p className="mt-2 text-sm text-vault-300">
          أدخل كلمة المرور ورمز الأمان لإعادة اشتقاق مفتاح AES-256 على جهازك.
        </p>

        {error && (
          <p className="mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        <form onSubmit={unlock} className="mt-6 space-y-4 text-right">
          <input
            type="password"
            placeholder="كلمة المرور"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            dir="ltr"
            className="w-full rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-3 text-sm outline-none focus:border-accent/50"
          />
          <input
            type="password"
            inputMode="numeric"
            placeholder="رمز الأمان"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            dir="ltr"
            className="w-full rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-3 text-center text-2xl tracking-[0.5em] outline-none focus:border-accent/50"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-2xl bg-accent py-3 font-bold text-vault-950 transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "جارٍ الاشتقاق…" : "فتح الخزنة"}
          </button>
        </form>

        {biometric && (
          <button
            type="button"
            onClick={unlockBiometric}
            disabled={busy}
            className="mt-3 w-full rounded-2xl border border-white/10 py-3 text-sm text-vault-200 transition hover:bg-white/5"
          >
            👆 الفتح بمفتاح الجهاز (بصمة / FaceID)
          </button>
        )}
      </div>
    </main>
  );
}
