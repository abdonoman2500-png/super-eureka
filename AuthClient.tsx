"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import {
  createVaultKeyMaterial,
  enrollDevice,
  getDek,
  unlockWithPassword,
} from "@/lib/client/session";

type Mode = "login" | "signup";

export default function AuthClient({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [step, setStep] = useState<"credentials" | "pin">("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") {
        if (!/^\d{4,6}$/.test(pin)) {
          throw new Error("رمز الأمان يجب أن يكون من 4 إلى 6 أرقام");
        }
        if (password.length < 8) {
          throw new Error("كلمة المرور يجب ألا تقل عن 8 محارف");
        }
        setNote("جارٍ توليد مفتاح التشفير على جهازك…");
        const material = await createVaultKeyMaterial(password, pin);
        await api("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            pin,
            keyWrapSalt: material.keyWrapSalt,
            encryptedKeyBlob: material.encryptedKeyBlob,
            keyWrapIv: material.keyWrapIv,
          }),
        });
        await enrollDevice(getDek()!);
        router.push("/vault");
        return;
      }

      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setNote("");
      setStep("pin");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
      setNote(null);
    }
  };

  const submitPin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/pin", { method: "POST", body: JSON.stringify({ pin }) });
      setNote("جارٍ اشتقاق مفتاح فك التشفير محلياً…");
      const ok = await unlockWithPassword(password, pin);
      if (!ok) {
        throw new Error("تعذر فك غلاف المفتاح — تحقق من كلمة المرور والرمز");
      }
      await enrollDevice(getDek()!).catch(() => undefined);
      router.push("/vault");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
      setNote(null);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-12">
      <Link href="/" className="mb-8 flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-vault-500 to-accent text-xl glow-ring">
          ☁️
        </span>
        <span>
          <span className="block text-lg font-bold">NimbusVault</span>
          <span className="block text-xs text-vault-300">1 تيرابايت · مشفّرة تماماً</span>
        </span>
      </Link>

      <div className="glass animate-float-up rounded-3xl p-7">
        <h1 className="text-2xl font-black">
          {mode === "signup" ? "إنشاء خزنة جديدة" : "الدخول إلى خزنتك"}
        </h1>
        <p className="mt-2 text-sm leading-6 text-vault-300">
          {step === "pin"
            ? "أدخل رمز الأمان لإكمال فتح الخزنة واشتقاق مفتاح التشفير."
            : mode === "signup"
              ? "يتم توليد مفتاح AES-256 على جهازك. لا نرسل كلمة المرور أو الرمز إلى الخادم."
              : "تحقّق ثنائي: كلمة المرور للجلسة، والرمز السري لقفل الخزنة."}
        </p>

        {error && (
          <p className="mt-4 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {error}
          </p>
        )}

        {step === "credentials" ? (
          <form onSubmit={submitCredentials} className="mt-6 space-y-4">
            <label className="block text-sm">
              <span className="mb-2 block text-vault-200">البريد الإلكتروني</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                dir="ltr"
                className="w-full rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-3 text-sm outline-none transition focus:border-accent/50"
                placeholder="you@example.com"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-2 block text-vault-200">كلمة المرور</span>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                dir="ltr"
                className="w-full rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-3 text-sm outline-none transition focus:border-accent/50"
                placeholder="••••••••"
              />
            </label>
            {mode === "signup" && (
              <label className="block text-sm">
                <span className="mb-2 block text-vault-200">
                  رمز الأمان (4-6 أرقام) — يُستخدم في قفل التطبيق
                </span>
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{4,6}"
                  required
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  dir="ltr"
                  className="w-full rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-3 text-center text-2xl tracking-[0.6em] outline-none transition focus:border-accent/50"
                  placeholder="······"
                />
              </label>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-2xl bg-accent py-3 font-bold text-vault-950 transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "…" : mode === "signup" ? "إنشاء الخزنة" : "متابعة"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitPin} className="mt-6 space-y-4">
            <label className="block text-sm">
              <span className="mb-2 block text-vault-200">رمز الأمان</span>
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                required
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                dir="ltr"
                className="w-full rounded-2xl border border-white/10 bg-vault-900/70 px-4 py-3 text-center text-3xl tracking-[0.6em] outline-none transition focus:border-accent/50"
                placeholder="······"
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-2xl bg-accent py-3 font-bold text-vault-950 transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "…" : "فتح الخزنة"}
            </button>
            <button
              type="button"
              onClick={() => setStep("credentials")}
              className="w-full rounded-2xl border border-white/10 py-3 text-sm text-vault-300 transition hover:bg-white/5"
            >
              رجوع
            </button>
          </form>
        )}

        {note && (
          <p className="mt-4 text-center text-xs text-accent">
            {note}
            <span className="mt-2 block h-1 w-full overflow-hidden rounded-full shimmer" />
          </p>
        )}
      </div>

      <p className="mt-6 text-center text-sm text-vault-300">
        {mode === "signup" ? (
          <>
            لديك خزنة؟{" "}
            <Link href="/login" className="text-accent hover:underline">
              تسجيل الدخول
            </Link>
          </>
        ) : (
          <>
            لا تملك حساباً؟{" "}
            <Link href="/signup" className="text-accent hover:underline">
              أنشئ خزنة مجانية
            </Link>
          </>
        )}
      </p>
    </main>
  );
}
