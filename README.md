# NimbusVault — خزنة سحابية مشفّرة بمساحة 1 تيرابايت

تطبيق سحابي متكامل يمنح كل مستخدم **1 تيرابايت (1,099,511,627,776 بايت)** مع:
تشفير من الطرف للطرف (Zero-Knowledge)، رفع مجزأ متوازٍ عبر روابط موقّعة مسبقاً
(Pre-signed URLs)، بث فوري للوسائط، وبصمة تخزين محلية شبه معدومة.

هذا المستودع هو **المرجع التنفيذي الكامل (Reference Implementation)** للمعمارية
المطلوبة: الواجهة هنا مبنية بـ Next.js App Router لتشغيلها فوراً في المتصفح، بينما
نفس العقود (API contracts) تُستهلك حرفياً من عميل Flutter / React Native.

---

## 1. المعمارية

```
[الجهاز]                     [خادم الـ API (Metadata)]        [تخزين S3-compatible]
   │  1. POST /api/uploads  ──►  تحقق الحصة + توقيع الروابط
   │  2. AES-256-GCM محلياً  (لا يغادر النص الصريح الجهاز أبداً)
   │  3. PUT جزء/جزء  ───────────────────────────────────────►  R2 / S3 / MinIO
   │  4. POST /complete     ──►  تثبيت البيانات الوصفية + زيادة ذرّية للعداد
   │  5. GET  (Range)       ◄──  رابط موقع للقراءة  ◄────────  بث تدريجي
```

| الطبقة | التقنية |
| --- | --- |
| الواجهة | Next.js 16 (App Router) + Tailwind CSS 4، RTL عربي |
| الخلفية | Route Handlers على Node.js runtime |
| قاعدة البيانات | PostgreSQL + Drizzle ORM |
| التخزين | أي مزوّد متوافق مع S3 (Cloudflare R2 / B2 / Wasabi / MinIO) أو مشغّل محلي بنفس العقد |
| التشفير | WebCrypto / node:crypto — AES-256-GCM، PBKDF2-SHA512، ECDH P-256 |

### لماذا لا تمر الملفات عبر الـ API؟
`/api/uploads` يُصدر روابط **موقّعة مسبقاً** لكل جزء. الجهاز يرفع الأجزاء مباشرة إلى
مزوّد التخزين بـ 4 خيوط متوازية، فلا يستهلك خادم الـ API عرض نطاق ولا ذاكرة. عند
غياب متغيرات S3 يعمل المشغّل المحلي (`.vault-store/`) بنفس العقد تماماً: روابط HMAC
موقّعة، قابلة للانتهاء، ومخصصة لغرض واحد (put / part-put / get).

---

## 2. منظومة الأمان

| المتطلب | التنفيذ |
| --- | --- |
| كلمة المرور | Bcrypt cost 12 (`users.password_hash`) |
| رمز الأمان 4-6 أرقام | Bcrypt (Salted Hash) + قفل مؤقت بعد 5 محاولات فاشلة |
| الجلسات | JWT HS256 (15 دقيقة) + Refresh Token عشوائي 48 بايت يُخزَّن hashed مع تدوير (Rotation) وإبطال |
| قفل الخزنة | توكن `nv_unlock` قصير الأمد (30 دقيقة) يمنع أي وصول لبيانات الخزنة بدونه (HTTP 423) |
| Zero-Knowledge | مفتاح بيانات عشوائي DEK يُولَّد على الجهاز ويُغلَّف بمفتاح KEK مشتق من `PBKDF2(password ‖ PIN, salt, 310k)` — الخادم يخزّن النص المشفر فقط |
| بصمة/وجه الجهاز | زوج مفاتيح ECDH P-256: الخادم يصدر تحدياً + مفتاحاً مؤقتاً، والجهاز يشتق سراً مشتركاً ويختم التحدي بـ AES-GCM (إثبات الملكية) ثم يفك غلاف DEK محلياً |
| الحصة | زيادة/إنقاص ذرّية عبر `UPDATE ... WHERE used + n <= limit` مع رفض 507 |

## 3. السرعة وحماية مساحة الجهاز

- **رفع مجزأ**: أجزاء 8MB، 4 خيوط متوازية، إعادة محاولة تصاعدية لكل جزء، إيقاف/استئناف.
- **استئناف عبر الجلسات**: `GET /api/uploads/:id` يعيد إصدار روابط أجزاء جديدة لجلسة معلّقة.
- **Zero Footprint**: لا يُكتب أي ملف على القرص؛ الفيديو/الصورة يُفك تشفيره في الذاكرة
  ويُعرض عبر Blob URL يُبطَل فور الإغلاق.
- **كاش LRU للمصغرات 200MB**: مفاتيح `thumb:<fileId>` في Cache Storage + فهرس IndexedDB،
  وحذف تلقائي للأقدم عند بلوغ 90% من الحد.
- **HTTP Range**: `/api/storage/object` يدعم `bytes=start-end` ويعيد 206 + `Content-Range`.

## 4. مخطط قاعدة البيانات

`users` · `sessions` · `folders` (شجرية عبر `parent_id`) · `files` · `upload_sessions`
· `device_credentials` · `auth_challenges` · `audit_log`

كل جدول معرّف في `src/db/schema.ts` بـ Drizzle، والتطبيق يتم عبر:

```bash
npx drizzle-kit push
```

## 5. واجهات الـ API

| الطريقة | المسار | الوظيفة |
| --- | --- | --- |
| POST | `/api/auth/register` | إنشاء حساب + استلام غلاف المفتاح المشفر |
| POST | `/api/auth/login` | منح كلمة المرور → زوج التوكنات |
| POST | `/api/auth/refresh` | تدوير الـ Refresh Token |
| POST | `/api/auth/logout` | إبطال الجلسة |
| GET | `/api/auth/me` | حالة الجلسة والقفل |
| POST | `/api/auth/pin` | التحقق من الرمز السري → توكن فتح الخزنة |
| POST | `/api/auth/lock` | إعادة قفل الخزنة |
| GET | `/api/vault/key` | غلاف DEK (نص مشفر فقط) |
| POST/GET/DELETE | `/api/auth/biometric` | تسجيل/عرض/حذف مفاتيح الأجهزة |
| POST | `/api/auth/biometric/begin` | إصدار تحدي ECDH |
| POST | `/api/auth/biometric/verify` | إثبات الملكية وفتح الخزنة |
| GET/POST | `/api/vault` | تصفح مجلد/بحث/مفضلة + إنشاء مجلد |
| PATCH/DELETE | `/api/folders/:id` | إعادة تسمية/نقل/حذف تتابعي |
| PATCH/DELETE | `/api/files/:id` | إعادة تسمية/نقل/مفضلة/حذف |
| POST/GET | `/api/uploads` | بدء رفع + روابط موقّعة / استئناف |
| POST | `/api/uploads/:id/complete` | تثبيت البيانات الوصفية + العداد الذرّي |
| POST | `/api/uploads/:id/abort` | إلغاء وتحرير المساحة |
| PUT/GET | `/api/storage/object` | الكتابة/القراءة المباشرة (موقّعة + Range) |
| PUT | `/api/storage/part` | رفع جزء من رفع مجزأ |
| GET | `/api/health` | فحص الصحة |

## 6. التشغيل

```bash
npm install
npx drizzle-kit push
npm run build && npm run start
```

### ربط تخزين سحابي حقيقي

```env
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_BUCKET=nimbusvault
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
# اختياري
AUTH_SECRET=<32+ bytes random>
STORAGE_SIGNING_SECRET=<32+ bytes random>
VAULT_STORAGE_DIR=./.vault-store
```

عند ضبط هذه المتغيرات يتحول المشغّل تلقائياً إلى SigV4 حقيقي (توقيع
الاستعلام + ترويسات طلبات التحكم في الرفع المجزأ) بدون أي اعتماديات إضافية.
تأكد من ضبط `Expose-Headers: ETag` في إعدادات CORS للـ bucket.

## 7. الربط مع عميل Flutter

العقود جاهزة للاستهلاك من `dart`/`dio`:

| ما يحتاجه Flutter | ما يقابله هنا |
| --- | --- |
| `flutter_secure_storage` / Keystore / Keychain | `src/lib/client/session.ts` (DEK في الذاكرة + غلاف الجهاز) |
| `pointycastle` AES-GCM | `src/lib/client/crypto.ts` (`encryptChunk` / `decryptObjectStream`) |
| `dio` + `Isolate.run` للرفع المتوازي | `src/lib/client/uploader.ts` (4 خيوط + إعادة محاولة + استئناف) |
| `cached_network_image` + LRU | `src/lib/client/cache.ts` (200MB) |
| `video_player` + HLS/Range | `/api/storage/object` (دعم 206 Partial Content) |
| `local_auth` (بصمة/FaceID) | `/api/auth/biometric/*` (تحدي ECDH + ختم AES-GCM) |

## 8. الاختبارات

```bash
node scripts/e2e-check.mjs   # 28 تحققاً: تسجيل، رمز، رفع مجزأ، Range، حصة، قفل، بصمة
```
