import Link from "next/link";
import { formatBytes, STORAGE_LIMIT_BYTES } from "@/lib/shared/constants";

const features = [
  {
    icon: "🔐",
    title: "تشفير من الطرف للطرف (Zero-Knowledge)",
    body: "مفتاح AES-256-GCM يُولَّد على جهازك ويُشتق من كلمة المرور والرمز السري عبر PBKDF2-SHA512 (310,000 دورة). الخادم يرى نصاً مشفراً فقط.",
  },
  {
    icon: "⚡",
    title: "رفع مجزأ متوازٍ بـ 4 خيوط",
    body: "الملفات الكبيرة تُقسم إلى أجزاء 8MB وتُرفع مباشرة إلى التخزين المتوافق مع S3 عبر روابط موقعة مسبقاً، مع إعادة محاولة واستئناف تلقائي.",
  },
  {
    icon: "🪶",
    title: "بصمة صفرية على الجهاز",
    body: "لا يُخزَّن أي ملف محلياً. ذاكرة مؤقتة LRU للصور المصغرة بحد 200MB تُحذف تلقائياً عند الامتلاء، والباقي يُبث عند الطلب.",
  },
  {
    icon: "🛡️",
    title: "رمز سري + بصمة الجهاز",
    body: "قفل التطبيق برمز 4-6 أرقام (Bcrypt مع قفل مؤقت بعد 5 محاولات) ومفتاح جهاز ECDH P-256 لإثبات الملكية عند الفتح بالبصمة.",
  },
  {
    icon: "🎯",
    title: "حصة صارمة 1 تيرابايت",
    body: "زيادة/إنقاص ذرّي لعداد الاستهلاك على مستوى قاعدة البيانات مع رفض فوري (HTTP 507) عند بلوغ الحد 1,099,511,627,776 بايت.",
  },
  {
    icon: "🎬",
    title: "بث تدريجي للوسائط",
    body: "الخادم يدعم HTTP Range Requests، والعميل يفك التشفير تدفقياً في الذاكرة ثم يعرض الوسائط عبر Blob URL قابل للإبطال.",
  },
];

const pipeline = [
  { step: "1", title: "طلب رفع", body: "العميل يرسل الاسم والحجم والنوع والمجلد فقط" },
  { step: "2", title: "توقيع الروابط", body: "الخادم يتحقق من الحصة ويوقّع روابط الأجزاء مسبقاً" },
  { step: "3", title: "تشفير + رفع", body: "AES-256-GCM محلياً ثم PUT مباشر للسحابة بـ 4 خيوط" },
  { step: "4", title: "تثبيت البيانات", body: "تحديث الجدول والعداد الذرّي للمساحة" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-10 sm:py-16">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-vault-500 to-accent text-xl glow-ring">
            ☁️
          </div>
          <div>
            <p className="text-lg font-bold tracking-tight">NimbusVault</p>
            <p className="text-xs text-vault-300">خزنة سحابية مشفّرة</p>
          </div>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link
            href="/login"
            className="rounded-xl px-4 py-2 text-vault-200 transition hover:bg-white/5"
          >
            تسجيل الدخول
          </Link>
          <Link
            href="/signup"
            className="rounded-xl bg-accent px-4 py-2 font-semibold text-vault-950 transition hover:brightness-110"
          >
            إنشاء خزنة مجانية
          </Link>
        </nav>
      </header>

      <section className="mt-14 grid items-center gap-10 lg:grid-cols-[1.15fr_1fr]">
        <div className="animate-float-up">
          <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            تشفير من الطرف للطرف · بروتوكول متوافق مع S3 / R2 / MinIO
          </span>
          <h1 className="mt-5 text-4xl leading-tight font-black sm:text-5xl">
            مساحة تخزين{" "}
            <span className="bg-gradient-to-l from-accent to-vault-300 bg-clip-text text-transparent">
              1 تيرابايت
            </span>{" "}
            دون أن تلمس مساحة هاتفك
          </h1>
          <p className="mt-5 max-w-xl text-base leading-8 text-vault-200/90">
            تُشفَّر ملفاتك على جهازك قبل أن تغادره، ثم تُرفع مجزأةً ومباشرةً إلى التخزين
            السحابي عبر روابط موقّعة مسبقاً. إدارة الخادم لا تستطيع معاينة صورك أو
            فيديوهاتك، وهاتفك لا يحتفظ إلا بمصغرات خفيفة قابلة للحذف التلقائي.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/signup"
              className="rounded-2xl bg-accent px-6 py-3 font-bold text-vault-950 transition hover:brightness-110"
            >
              ابدأ الآن — 1TB مجاناً
            </Link>
            <Link
              href="/login"
              className="glass rounded-2xl px-6 py-3 font-semibold text-vault-100 transition hover:bg-white/10"
            >
              لدي خزنة بالفعل
            </Link>
          </div>
          <dl className="mt-10 grid grid-cols-3 gap-3 text-center">
            {[
              ["1 TB", "لكل مستخدم"],
              ["4", "خيوط رفع متوازية"],
              ["200 MB", "حد الكاش المحلي"],
            ].map(([value, label]) => (
              <div key={label} className="glass rounded-2xl px-3 py-4">
                <dt className="text-xl font-black text-accent">{value}</dt>
                <dd className="mt-1 text-xs text-vault-300">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="glass animate-float-up rounded-3xl p-6">
          <div className="flex items-center justify-between text-sm text-vault-300">
            <span>الاستهلاك الحالي</span>
            <span className="text-vault-100">0 / {formatBytes(STORAGE_LIMIT_BYTES)}</span>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/5">
            <div className="h-full w-[3%] rounded-full bg-gradient-to-l from-accent to-vault-400" />
          </div>
          <div className="mt-6 space-y-3 text-sm">
            {[
              ["AES-256-GCM", "تشفير كل جزء بمتجه تهيئة عشوائي"],
              ["Pre-signed URLs", "رفع مباشر يتجاوز خادم الـ API"],
              ["HTTP Range", "بث تدريجي للفيديو دون تنزيل كامل"],
              ["Argon-grade hashing", "Bcrypt cost 12 لكلمة المرور والرمز"],
            ].map(([title, body]) => (
              <div
                key={title}
                className="flex items-start gap-3 rounded-2xl bg-white/[0.03] p-3"
              >
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-accent" />
                <div>
                  <p className="font-semibold text-vault-100">{title}</p>
                  <p className="text-xs text-vault-300">{body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-black">دورة عمل الرفع والتشغيل</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-4">
          {pipeline.map((item) => (
            <div key={item.step} className="glass relative rounded-3xl p-5">
              <span className="absolute -top-3 right-5 grid h-8 w-8 place-items-center rounded-xl bg-vault-700 text-sm font-bold text-accent">
                {item.step}
              </span>
              <p className="mt-3 font-bold text-vault-100">{item.title}</p>
              <p className="mt-2 text-sm leading-6 text-vault-300">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-black">المنظومة الأمنية والسرعة</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <article key={feature.title} className="glass rounded-3xl p-6">
              <span className="text-2xl">{feature.icon}</span>
              <h3 className="mt-4 font-bold text-vault-100">{feature.title}</h3>
              <p className="mt-2 text-sm leading-7 text-vault-300">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className="mt-20 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-6 text-xs text-vault-300">
        <p>NimbusVault — معمارية تخزين سحابي مشفّرة جاهزة للإنتاج.</p>
        <p>Next.js · PostgreSQL · Drizzle · S3-compatible object storage</p>
      </footer>
    </main>
  );
}
