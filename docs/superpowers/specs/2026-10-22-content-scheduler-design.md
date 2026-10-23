# SocialAuto — Content Scheduler: Texnik topshiriq (TZ)

Oct 22, 2026 · Egasi: @Jamolxon. Repo'ga 2026-10-22 kuni asl matn bilan kiritildi.
Qurilish: avval `/developer/content` (BUILDING → TESTING), keyin egasi qarori bilan
asosiy mahsulotga (master TZ 1.2 va 63-bo'lim tartibi).

## Ochiq savollarga qaror (15-bo'lim) — dasturchi qarori, 2026-10-22

Egasi javob bermaguncha quyidagi standartlar bilan quriladi; har biri env/config
bilan o'zgartiriladi, kod qayta yozilmaydi.

| # | Savol | Qaror |
|---|---|---|
| 1 | Obyekt ombori | S3-mos driver (`@aws-sdk/client-s3`): R2, Lightsail, MinIO — hammasi bitta `MEDIA_S3_*` config. Tavsiya R2. Lokal dev uchun `MEDIA_STORAGE_DRIVER=local` (fayl tizimi, faqat UI sinovi; Meta localhost'dan yuklay olmaydi). |
| 2 | Tarif limitlari | `CONTENT_STORAGE_QUOTA_BYTES` (standart 5 GB), post limiti API kvotasidan; tarifga bog'lash keyin admin paneldan. |
| 3 | YaTT sanasi | Egasi ishi; App Review'gacha modul faqat tester akkauntlarda (@jamalxann). |
| 4 | Qayerda | Avval `/developer/content`, TESTING; asosiy menyuga egasi tasdig'i bilan. |
| 5 | Boshqa tarmoqlar | `channel` maydoni qo'shilmaydi; `PostType` + `instagramAccountId` (TZ 8). Kerak bo'lsa nullable migratsiya bilan. |
| 6 | Telegram qo'lda e'lon | Workspace'ga ulangan barcha faol chatlar (`notifyWorkspaceChats`) — mavjud lead/ogohlantirish yo'li bilan bir xil. |

Karusel limiti `CAROUSEL_MAX_ITEMS` (standart 10), hammualliflar `IG_MAX_COLLABORATORS`
(standart 3), kechikish `LATE_PUBLISH_MAX_MIN` (standart 15) — env.

---

## 0. Qisqacha xulosa

SocialAuto'ga Content Scheduler moduli qo'shiladi: Instagram feed post, karusel, Reels,
Trial Reels va Stories'ni oldindan rejalashtirish, odamlarni belgilash (user tags),
hammualliflar (collaborators), birinchi komment, muqova, alt matn va hashtag guruhlari
bilan. Funksional doira Metricool Planner'ga teng, lekin SocialAuto'ning asosiy
ustunligi — post chiqqan zahoti unga comment-to-DM kampaniyasi avtomatik ulanadi.

Asosiy qarorlar:

- Publish faqat rasmiy Instagram Content Publishing API orqali (Instagram Login,
  `instagram_business_content_publish` ruxsati). Scraping, parol, brauzer avtomatizatsiyasi yo'q.
- API qila olmaydigan narsa (story sticker, link, so'rovnoma, musiqa) uchun "Telegram orqali
  qo'lda e'lon" rejimi — Metricool push-notification rejimining analogi, mavjud Telegram bot orqali.
- Media obyekt omboriga (S3-mos) yuklanadi: Instagram Login'da resumable upload yo'q, Meta faylni
  ochiq URL'dan o'zi yuklab oladi.
- Mavjud funksiyalar buzilmaydi: yangi navbat (`content-publish`), yangi jadvallar, mavjud
  `dm-processing` navbati va Automation/TriggerCampaign jadvallariga faqat qo'shimcha maydon.
- Modul avval `/developer` hududida BUILDING → TESTING, keyin egasi qarori bilan asosiy mahsulotga.

## 1. SocialAuto hozirgi holati

Kontent rejalashtirish yo'q (master TZ ETAP 10 "Meta publishing ruxsatigacha kechiktirilgan").
Stack: Next.js 16 (App Router) + React 19, TypeScript, Prisma 7 + PostgreSQL, BullMQ 5 + Redis,
NextAuth 5, Tailwind 4, Vitest. Production — bitta serverda Docker Compose: web, worker, cron,
postgres, redis.

Instagram ulanishi: Instagram API with Instagram Login (graph.instagram.com, v25.0). Joriy
ruxsatlar: `instagram_business_basic`, `instagram_business_manage_messages`,
`instagram_business_manage_comments`, `instagram_business_manage_insights`.
`instagram_business_content_publish` yo'q — birinchi bloker.

Jonli holat (22-oktabr 2026): @jamalxann CONNECTED, webhook faol, token 2026-12-06 gacha;
1 faol + 1 test kampaniya; worker/navbat/webhook xato 0; amoCRM uzilgan; Telegram ulanmagan.

Qayta foydalaniladigan qismlar:

| Mavjud qism | Scheduler'da roli |
|---|---|
| InstagramAccount + token salomatligi (tokenStatus, check-tokens cron) | Publishdan oldin token tekshiruvi, BROKEN bo'lsa publish to'xtaydi |
| BullMQ + worker/dm-worker.ts | Yangi `content-publish` navbati shu worker jarayonida |
| scripts/cron.sh + /api/cron/* | Sweeper: o'tkazib yuborilgan postlarni qayta navbatga qo'yish |
| attach-next-reel cron + Automation.pendingNextReel | O'rniga aniq bog'lanish: post publish bo'lganda kampaniya darhol ulanadi |
| Telegram bot (lib/telegram) | Qo'lda e'lon rejimi va xato bildirishnomalari |
| Workspace rollari (lib/workspace-permissions) | Kim yaratadi, kim tasdiqlaydi |
| OperationalEvent, diagnostika, xato katalogi | Publish xatolari tushunarli matn bilan |
| lib/assistant/llm | AI caption va hashtag generatori |
| i18n (uz/ru/en), DESIGN.md tokenlari | Barcha yangi ekranlar |
| MCP qatlami | list_scheduled_posts, create_post_draft (preview + tasdiq) |

Yetishmaydi: obyekt ombori (S3/R2); video/rasm qayta ishlash (ffmpeg, sharp).

## 2. Metricool tahlili: nimani olamiz

| Metricool imkoniyati | SocialAuto qarori | Prioritet |
|---|---|---|
| Post turlari: POST (rasm/karusel), REEL, TRIAL_REEL, STORY | Hammasi | P0 (Trial Reel P1) |
| Auto-publish / qo'lda e'lon toggle; talabga mos kelmasa avtomatik qo'lda | Xuddi shunday; qo'lda e'lon Telegram bot orqali | P0 |
| Odam belgilash (post va Reels; faqat ochiq akkauntlar) | user_tags x/y, rasm ustida bosib belgilash | P0 |
| Hammualliflar (5 tagacha) | collaborators; API 3 deydi — limit config | P0 |
| Birinchi komment (faqat feed) | Hamma feed turlari uchun (/comments bilan) | P0 |
| Joylashuv | location_id; qo'lda ID | P2 |
| Alt matn (faqat rasm) | Rasm va karusel rasmi, 1000 belgi | P1 |
| Muqova (kadr yoki rasm) | cover_url yoki thumb_offset (ms) | P0 |
| Reels'ni feed'da ko'rsatish | share_to_feed | P0 |
| Audio | audio_name; musiqa = qo'lda | P2 |
| AI-generated belgisi | is_ai_generated | P1 |
| Kalendar + ro'yxat + filtr + qidiruv | Oy/hafta/kun + ro'yxat + filtr | P0 |
| Feed preview | Instagram grid preview | P1 |
| Eng yaxshi vaqt | online_followers (100+) + o'z postlar statistikasi | P1 |
| Saqlangan matnlar (16 192 belgi) | Hashtag guruhlari va shablonlar | P0 |
| Takroriy post (180 kun / 200 post) | Shu limitlar bilan | P2 |
| Autolists | "Navbat slotlari" | P2 |
| CSV import (50 qator tavsiya) | Shu format, preview va xato | P1 |
| Tasdiqlash (har kim / hamma / avto; tashqi reviewer; 3 soat grace) | To'liq, Telegram tugmalari bilan | P1 |
| Izohlar | Postga ichki izoh | P1 |
| Boshqa brendga nusxa | Boshqa IG akkauntga nusxa | P1 |
| AI matn generatori | lib/assistant/llm | P1 |
| UTM builder, SmartLinks | Mavjud TrackedLink bilan UTM | P2 |
| Canva, Drive, Dropbox | Keyinroq; v1 — kompyuterdan va URL | P3 |
| Publish limiti 50/24 soat | API'dan real kvota | P0 |

SocialAuto ustunliklari: (1) post → kampaniya bog'lanishi, publish bo'lishi bilan kampaniya
o'sha media_id ga faollashadi; (2) Telegram'da tasdiqlash va qo'lda e'lon; (3) o'zbek AI caption
va Asia/Tashkent standart.

## 3. Instagram Content Publishing API

Oqim: (1) `POST /{ig_id}/media` — image_url/video_url + parametrlar → konteyner ID;
(2) karusel: har element `is_carousel_item=true`, keyin `media_type=CAROUSEL` + `children`;
(3) `GET /{container_id}?fields=status_code` — IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED;
(4) `POST /{ig_id}/media_publish` — creation_id → media ID; (5) birinchi komment
`POST /{media_id}/comments`.

Parametrlar (`POST /media`):

| Parametr | Qayerda | Cheklov |
|---|---|---|
| caption | Rasm, video, Reels, karusel (elementlarda emas) | 2200 belgi, 30 hashtag, 20 @mention |
| media_type | REELS, STORIES, CAROUSEL | Rasm uchun berilmaydi |
| user_tags | Rasm (x,y majburiy), Reels, Story (x,y ixtiyoriy) | Faqat ochiq akkauntlar; 0.0–1.0 |
| collaborators | Feed rasm, Reels, karusel; Story'da yo'q | 3 username |
| alt_text | Rasm va karusel rasmi | 1000 belgi |
| cover_url | Reels | JPEG, 8 MB; thumb_offset dan ustun |
| thumb_offset | Video, Reels | ms, standart 0 |
| share_to_feed | Reels | true = feed + Reels tab |
| audio_name | Reels | Bir marta |
| trial_params | Reels | graduation_strategy: MANUAL / SS_PERFORMANCE |
| location_id | Rasm, Reels | Facebook Page ID |
| is_ai_generated | Rasm, Reels, karusel konteyneri, Story | Elementlarda emas |

Media talablari:

| Tur | Format | Hajm | Nisbat | Davomiylik |
|---|---|---|---|---|
| Feed rasm | JPEG, sRGB | 8 MB | 4:5 … 1.91:1, kenglik 320–1440 | — |
| Reels | MP4/MOV, H.264/HEVC, 23–60 fps, ≤25 Mbps, AAC ≤48 kHz 128 kbps, moov oldinda | 300 MB | 0.01:1 … 10:1, 9:16 tavsiya | 3 s – 15 daq |
| Story rasm | JPEG, sRGB | 8 MB | 9:16 tavsiya | 24 soat |
| Story video | Reels kabi | 100 MB | 0.1:1 … 10:1 | 3 – 60 s |
| Karusel | Rasm + video | Har biri o'z limiti | 1-element bo'yicha qirqiladi | Video ≤60 s |

Limitlar: publish kvotasi `content_publishing_limit` (hujjat 50/100 — endpointdan o'qiladi;
karusel = 1 post); konteyner 400/24 soat, 24 soatda EXPIRED; karusel elementi 10 (config, 20 sinaladi).

API qila olmaydi (→ qo'lda e'lon): story link/so'rovnoma/stiker, musiqa, filtrlar, shopping/branded
teglar. PNG/WEBP/HEIC → avtomatik JPEG. Faqat Business/Creator; Creator'da story avto-publish
ishlamasa avtomatik qo'lda e'lon.

## 4. Scope va prioritetlar

- **P0 — MVP:** media ombori + yuklash; post turlari (rasm, karusel, Reels, Story); caption,
  hashtag, @mention; user tags; collaborators; first comment; Reels muqovasi va share_to_feed;
  vaqt tanlash (Asia/Tashkent); draft; kalendar (oy/hafta) + ro'yxat; publish pipeline, status,
  retry; qo'lda e'lon (Telegram); kvota hisoblagichi; hashtag guruhlari; post → comment-to-DM
  bog'lanishi; xato bildirishnomalari (Telegram + email + dashboard).
- **P1:** Trial Reels; alt matn; is_ai_generated; tasdiqlash oqimi va tashqi reviewer; izohlar;
  feed grid preview; eng yaxshi vaqt; boshqa akkauntga nusxa; CSV import; AI caption; story seriyasi.
- **P2:** takroriy post; navbat slotlari; location_id; audio_name; UTM; post statistikasi kalendarda.
- **P3:** Canva/Drive/Dropbox; so'rovnoma; RSS; boshqa tarmoqlar.

Doiradan tashqari: parol/norasmiy API; chiqqan postni tahrirlash (o'chirish Instagram'dagi postni
o'chirmaydi); reklama.

## 5. Funksional talablar

### 5.1 Media kutubxonasi
- **FR-M1.** Drag-and-drop, 20 tagacha; brauzer presigned PUT bilan to'g'ridan-to'g'ri omborga yuklaydi.
- **FR-M2.** JPEG, PNG, WEBP, HEIC (30 MB); MP4, MOV (1 GB). Worker metama'lumot o'qiydi.
- **FR-M3.** Avtomatik moslashtirish: rasm → JPEG sRGB ≤1440 <8 MB; video → H.264 + AAC 128 kbps
  48 kHz ≤25 Mbps faststart fps 23–60. Asl saqlanadi, tayyorlangan nusxa alohida.
- **FR-M4.** Crop: 1:1, 4:5, 1.91:1, 9:16; karuselda 1-element nisbati hammaga.
- **FR-M5.** Kutubxona: teglar, qidiruv, "ishlatilgan postlar"; o'chirish faqat ishlatilmagan bo'lsa.
- **FR-M6.** Video muqovasi: kadr (ms) yoki rasm.

### 5.2 Composer
- **FR-C1.** Akkaunt tanlash (bir post — bitta akkaunt).
- **FR-C2.** Tur: Feed post, Karusel (2–10), Reels, Trial Reels (P1), Story. Video + "Feed post" → Reels (ogohlantirish).
- **FR-C3.** Caption hisoblagichlar (2200 / 30 # / 20 @); oshsa tugma o'chadi.
- **FR-C4.** Hashtag guruhlari va saqlangan matnlar: caption'ga yoki birinchi kommentga.
- **FR-C5.** Odam belgilash: rasmda bosilgan nuqta (x,y 0–1); Reels/Story koordinatasiz; karuselda har rasmga.
- **FR-C6.** Hammualliflar ≤ IG_MAX_COLLABORATORS, ogohlantirish matni bilan.
- **FR-C7.** Birinchi komment (2200), publishdan 5–30 s keyin; xato → "Chiqdi, komment xatosi" + qayta urinish.
- **FR-C8.** Reels: muqova, share_to_feed (standart on), audio nomi (P2), Trial strategiya (P1).
- **FR-C9.** Story seriyasi: bir nechta media → har biri alohida story, 1 daqiqa oraliq; caption yo'q.
- **FR-C10.** Story'ga stiker/musiqa → "Qo'lda e'lon" belgisi → NEEDS_MANUAL rejimi.
- **FR-C11.** Alt matn (P1), is_ai_generated (P1), joylashuv (P2).
- **FR-C12.** Jonli preview (feed karta, Reels 9:16, Story 9:16).
- **FR-C13.** Avto-saqlash har 5 s.

### 5.3 Rejalashtirish
- **FR-S1.** Sana+soat, workspace timezone (Asia/Tashkent), bazada UTC; min hozir+5 daq.
- **FR-S2.** "Hozir chiqarish".
- **FR-S3.** Kvota nazorati (24 soat sirpanuvchi oyna); 50 dan ortiq taqiq (config).
- **FR-S4.** Bir akkauntga bir daqiqada 2 post → 2 daqiqa oraliq.
- **FR-S5.** Publishgacha tahrirlash/vaqt/pauza/draft/o'chirish; PUBLISHING tahrirlanmaydi.
- **FR-S6.** Kalendarda drag-and-drop (SCHEDULED, DRAFT).
- **FR-S7.** Eng yaxshi vaqt (P1). **FR-S8.** Takroriy (P2). **FR-S9.** Navbat slotlari (P2).

### 5.4 Publish
- **FR-P1.** ±60 s aniqlik.
- **FR-P2.** Oldindan tekshiruv: token ACTIVE, ruxsat bor, kvota bo'sh, media READY.
- **FR-P3.** Konteyner oldindan (30 daq; video 60 daq) yaratiladi, FINISHED kutiladi, vaqtida faqat media_publish. ≤ 23 soat oldin.
- **FR-P4.** igMediaId, permalink, publishedAt saqlanadi.
- **FR-P5.** Idempotentlik: DB qulfi + status tekshiruvi; javob kelmasa status_code so'raladi.

### 5.5 Qo'lda e'lon (Telegram)
- **FR-N1.** Avto o'chirilgan yoki mos kelmagan postlar shu rejimda.
- **FR-N2.** Vaqtida chatga media, caption alohida xabarda, hashtaglar, teglar, "Instagram'ni ochish" + "E'lon qildim" / "Bekor qilish" tugmalari.
- **FR-N3.** "E'lon qildim" → PUBLISHED_MANUAL; 30 daqiqada media ro'yxatidan igMediaId bog'lanadi.
- **FR-N4.** Telegram yo'q → email + dashboard ("Faylni yuklab olish", "Caption'dan nusxa").

### 5.6 Comment-to-DM bog'lanish
- **FR-L1.** Composer'da "Avtomatlashtirish": mavjud kampaniya yoki yangisi (Automation / TriggerCampaign).
- **FR-L2.** Kampaniya WAITING_FOR_POST (scheduledPostId != null, postId/mediaIds bo'sh) — hech narsa yubormaydi.
- **FR-L3.** Publish → bitta tranzaksiyada igMediaId yoziladi va ACTIVE (≤ 2 s).
- **FR-L4.** Post bekor/o'chirilsa kampaniya PAUSED.
- **FR-L5.** Caption'da keyword chaqiruvi yo'q bo'lsa ogohlantirish.

### 5.7 Tasdiqlash (P1)
- **FR-A1.** OWNER/ADMIN/MANAGER rejalashtiradi; OPERATOR faqat tasdiqqa yuboradi; VIEWER ko'radi.
  Ruxsatlar: content.create, content.schedule, content.approve.
- **FR-A2.** Reviewerlar: a'zolar + tashqi email (tokenli). ANY / ALL / OPTIONAL; bitta rad to'xtatadi.
- **FR-A3.** Tahrirlash tasdiqni nolga tushiradi.
- **FR-A4.** Vaqtida PENDING_REVIEW → 3 soat grace → EXPIRED_REVIEW.
- **FR-A5.** Rad etishda izoh majburiy; Telegram tugmalari.

### 5.8 Kalendar, ro'yxat
- **FR-V1.** Oy, Hafta, Ro'yxat; filtrlar: akkaunt, tur, status, teg, kampaniya; qidiruv.
- **FR-V2.** Karta: thumbnail, tur, vaqt, status rangi, DM belgisi.
- **FR-V3.** Feed grid preview (P1). **FR-V4.** Ommaviy amallar.

### 5.9 CSV import (P1)
- **FR-I1.** Ustunlar: text, date, time, account, type, media_url_1..10, alt_text_1..10, cover_url,
  cover_frame_ms, share_to_feed, first_comment, collaborators, user_tags (@user:x:y;…), draft, autopublish, campaign_keyword.
- **FR-I2.** UTF-8; 200 qator; preview; xato qatorlar tuzatiladi.

### 5.10 AI (P1)
- **FR-AI1.** Caption: mavzu + ohang + til → 3 variant; hashtag ≤15; LlmUsage, byudjet.

## 6. Format bo'yicha maydonlar matritsasi

| Maydon | Feed rasm | Feed video (→Reels) | Karusel | Reels | Trial Reels | Story |
|---|---|---|---|---|---|---|
| Media | 1 JPEG | 1 video | 2–10 rasm/video | 1 video | 1 video | 1 rasm/video |
| Caption | ✅ | ✅ | ✅ umumiy | ✅ | ✅ | ❌ |
| Odam belgilash | ✅ x,y | ✅ | ✅ har rasmda | ✅ | ✅ | ✅ (x,y ixtiyoriy) |
| Hammualliflar (≤3) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Birinchi komment | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Alt matn | ✅ | ❌ | ✅ rasmlarga | ❌ | ❌ | ❌ |
| Muqova / kadr | ❌ | ✅ | ❌ | ✅ | ✅ | ❌ |
| Feed'da ko'rsatish | — | ✅ | — | ✅ | ❌ | — |
| Trial strategiyasi | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Joylashuv (P2) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| AI belgisi | ✅ | ✅ | ✅ konteyner | ✅ | ✅ | ✅ |
| Kampaniya bog'lash | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ story-reply |
| Avto-publish | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ stikersiz |

Validatsiya (server, publishdan oldin ham): caption ≤2200, ≤30 #, ≤20 @; rasm nisbati 4:5…1.91:1
(crop majburiy); Reels 3 s–15 daq ≤300 MB; Story video 3–60 s ≤100 MB; karusel video ≤60 s;
karusel 2..limit; username `^[a-zA-Z0-9._]{1,30}$`, @ olib tashlanadi, takrorlar birlashadi;
koordinatalar 0–1, 4 kasr; vaqt ≥ hozir+5 daq va ≤ hozir+365 kun; story caption saqlanmaydi.

## 7. Arxitektura va publish pipeline

| Komponent | Joyi | Vazifasi |
|---|---|---|
| Composer UI, kalendar | app/developer/(secure)/content (keyin app/(dashboard)/content) | Yaratish, rejalashtirish, ko'rish |
| Content API | app/api/developer/content/* (keyin app/api/content/*) | CRUD, presign, validatsiya, approval |
| Domen | lib/content/* (schema, validate, publish, media, quota, link-campaign) | Barcha biznes qoidalar |
| Meta klient | lib/meta/publish.ts | createContainer, getContainerStatus, publishContainer, getPublishingLimit, createComment |
| Media worker | worker: media-process navbati | ffprobe/ffmpeg, sharp |
| Publish worker | worker: content-publish navbati | Konteyner, status, publish, komment, kampaniya |
| Sweeper | /api/cron/content-sweep har 1 daq | Yo'qolgan job'larni qayta navbatga |
| Obyekt ombori | S3-mos bucket (MEDIA_BUCKET) | Asl va tayyorlangan fayllar; Meta uchun 24 soatlik imzolangan GET |

Publish ketma-ketligi: Rejalashtirish → SCHEDULED → kechiktirilgan job prepareAt =
scheduledAt − 30 daq (video 60) → PREPARING: token/ruxsat → READY media → imzolangan URL →
POST /media (karuselda bolalar, keyin ota) → status kutish (30 s, video maks 20 daq) →
READY_TO_PUBLISH → scheduledAt da: kvota → PUBLISHING → media_publish → igMediaId →
permalink → PUBLISHED → shu tranzaksiyada kampaniya faollashadi → birinchi komment 10 s keyin
alohida job → bildirishnoma.

Statuslar: DRAFT → SCHEDULED | PENDING_REVIEW; PENDING_REVIEW → SCHEDULED | REJECTED |
EXPIRED_REVIEW; SCHEDULED → PREPARING | PAUSED | DRAFT; PAUSED → SCHEDULED | DRAFT; PREPARING →
READY_TO_PUBLISH | FAILED; READY_TO_PUBLISH → PUBLISHING; PUBLISHING → PUBLISHED | FAILED;
NEEDS_MANUAL → PUBLISHED_MANUAL | CANCELED; FAILED → SCHEDULED | NEEDS_MANUAL;
REJECTED / EXPIRED_REVIEW / CANCELED → DRAFT.

Ishonchlilik: kechiktirilgan job + har daqiqalik sweeper; job ID `publish:{postId}:{attempt}`;
status o'tishlari `UPDATE … WHERE status = <kutilgan>` (optimistic lock, `version`);
bitta akkauntga 1 publish (Redis lock `content:acct:{id}`), umumiy 5; 15 daqiqadan ko'p
kechikkan post FAILED + "hozir chiqaraymi?" (LATE_PUBLISH_MAX_MIN).

Media oqimi: presign → PUT → complete → media-process (ffprobe/sharp, transkod, 640 px thumb)
→ READY; imzolangan GET faqat publish paytida (24 soat); tayyorlangan nusxa 30 kundan keyin
o'chadi; workspace kvotasi.

## 8. Ma'lumotlar modeli (Prisma)

Enumlar: `PostType { FEED_IMAGE FEED_VIDEO CAROUSEL REEL TRIAL_REEL STORY }`,
`PostStatus { DRAFT PENDING_REVIEW SCHEDULED PAUSED PREPARING READY_TO_PUBLISH PUBLISHING
PUBLISHED NEEDS_MANUAL PUBLISHED_MANUAL FAILED REJECTED EXPIRED_REVIEW CANCELED }`,
`MediaStatus { UPLOADING PROCESSING READY FAILED DELETED }`, `ReviewRule { ANY ALL OPTIONAL }`.

Modellar: `MediaAsset` (workspaceId, uploadedById, kind, originalKey, preparedKey, thumbKey,
mimeType, sizeBytes BigInt, width, height, durationMs, codec, fps, status, error, tags[]),
`ScheduledPost` (workspaceId, instagramAccountId, createdById, type, status, caption,
firstComment, collaborators[], shareToFeed, coverMediaId, thumbOffsetMs, trialStrategy,
audioName, locationId, isAiGenerated, autoPublish, manualReason, scheduledAt UTC, timezone,
seriesId, seriesIndex, containerId, containerStatus, igMediaId @unique, permalink,
publishedAt, firstCommentId, firstCommentStatus, attempts, lastErrorCode, lastErrorMessage,
reviewRule, reviewSubmittedAt, labels[], version, deletedAt; indekslar [status, scheduledAt],
[workspaceId, scheduledAt], [instagramAccountId, scheduledAt]), `ScheduledPostMedia` (postId,
mediaId, position, altText, userTags Json, cropRect Json, containerId; @@unique(postId,
position); media onDelete Restrict), `PublishAttempt` (postId, step, ok, metaCode, metaSubcode,
fbTraceId, message, durationMs), `PostReview` (reviewerUserId, externalEmail, tokenHash,
decision, comment, postVersion, decidedAt), `PostNote`, `SavedText` (title ≤32, body ≤16 192,
tags[]), `PostingSlot` (instagramAccountId, weekday, minuteOfDay, postType).

Mavjud modellarga: InstagramAccount — grantedScopes String[], canPublish Boolean, accountType,
publishQuotaUsed, publishQuotaCheckedAt; Workspace — timezone, mediaStorageBytes BigInt;
Automation — scheduledPostId; TriggerCampaign — scheduledPostId.
"Post kutilmoqda" = scheduledPostId != null AND postId IS NULL (yoki mediaIds bo'sh).

## 9. API endpointlar

Developer bosqichida prefiks `/api/developer/content`, keyin `/api/content`. Hammasi Zod +
`{ success, data | error }`.

| Metod va yo'l | Vazifa | Rol |
|---|---|---|
| POST media/presign | → presigned PUT + mediaId | OPERATOR+ |
| POST media/{id}/complete | → qayta ishlash navbati | OPERATOR+ |
| GET media | Kutubxona | VIEWER+ |
| DELETE media/{id} | Ishlatilmagan bo'lsa | MANAGER+ |
| GET posts?from&to&account&status&type | Kalendar/ro'yxat | VIEWER+ |
| POST posts | Draft | OPERATOR+ |
| GET posts/{id} | Post + media + urinishlar + izohlar | VIEWER+ |
| PATCH posts/{id} | Tahrirlash (version; 409) | OPERATOR+ |
| POST posts/{id}/schedule | {scheduledAt, timezone} | MANAGER+ |
| POST posts/{id}/publish-now | Darhol | MANAGER+ |
| POST posts/{id}/pause · resume · unschedule | Holat | MANAGER+ |
| POST posts/{id}/retry | FAILED → qayta | MANAGER+ |
| POST posts/{id}/mark-published | Qo'lda e'lon tasdig'i | OPERATOR+ |
| POST posts/{id}/duplicate | Nusxa | OPERATOR+ |
| DELETE posts/{id} | Soft delete | MANAGER+ |
| POST posts/{id}/review · decision · notes | Tasdiqlash (P1) | — |
| POST reviews/{token} | Tashqi reviewer (P1) | token |
| POST validate | Jonli tekshiruv | OPERATOR+ |
| GET accounts/{id}/quota | Real kvota + rejalashtirilganlar | VIEWER+ |
| GET accounts/{id}/best-times | P1 | VIEWER+ |
| GET/POST/PATCH/DELETE saved-texts | Shablonlar | OPERATOR+ |
| GET/PUT accounts/{id}/slots | P2 | MANAGER+ |
| POST import/csv · commit | P1 | MANAGER+ |
| POST ai/caption | P1 | OPERATOR+ |
| GET /api/cron/content-sweep | Sweeper | cron |

MCP: list_scheduled_posts, get_scheduled_post, create_post_draft (faqat DRAFT), get_publishing_quota.

## 10. UI/UX

Sidebar "Kontent": Kalendar, Kutubxona, Shablonlar, Tasdiqlar. DESIGN.md tokenlari, uz/ru/en, mobil.
10.1 Kalendar: akkaunt, Oy/Hafta/Ro'yxat, filtrlar, qidiruv, "+ Post yaratish"; bo'sh katak → composer;
kartalar (thumbnail, tur, vaqt, status rangi: SCHEDULED violet, PUBLISHED lime, FAILED error,
NEEDS_MANUAL warning, DRAFT muted); DM belgisi; kvota "Bugun 3/50".
10.2 Composer: chapda forma (akkaunt+tur; media; caption+hisoblagich; kengaytirilgan; avtomatlashtirish;
vaqt), o'ngda preview; pastki tugma holatga qarab.
10.3 Odam belgilash: rasmda pill, sudrash, ×. 10.4 Post tafsiloti: timeline, urinishlar, xato +
harakat. 10.5 Kutubxona, Shablonlar, Tasdiqlar; /review/[token]. 10.6 Bo'sh/xato holatlar:
canPublish=false banner; token BROKEN; Telegram ulanmagan.

## 11. Xatolar, retry, bildirishnomalar

| Kod | Holat | Matn | Harakat |
|---|---|---|---|
| PUBLISH_TOKEN_EXPIRED | Meta 190 | "Instagram ulanishi uzildi" | BROKEN, postlar SCHEDULED'da; 15 daq → FAILED |
| PUBLISH_NO_PERMISSION | 10/200 | "Post chiqarish ruxsati berilmagan — qayta ulang" | canPublish=false, retry yo'q |
| PUBLISH_QUOTA | kvota | "24 soatlik limit to'ldi, X:XX da chiqadi" | Qayta rejalashtirish |
| PUBLISH_RATE_LIMIT | 4, 17, 32, 613 | — | 1, 2, 4, 8 daq |
| PUBLISH_MEDIA_FETCH | fayl yuklanmadi | "Fayl yuklanmadi" | Yangi URL, 3 urinish |
| PUBLISH_MEDIA_INVALID | konteyner ERROR | Aniq sabab | FAILED + qo'lda |
| PUBLISH_CONTAINER_TIMEOUT | 20 daq | "Instagram videoni qayta ishlay olmadi" | 1 marta yangi konteyner |
| PUBLISH_CONTAINER_EXPIRED | EXPIRED | — | Yangi konteyner |
| PUBLISH_INVALID_USER_TAG / _COLLABORATOR | topilmadi/yopiq | "@xyz topilmadi yoki yopiq akkaunt" | Chiqmaydi, ogohlantirish |
| PUBLISH_PPA_REQUIRED | PPA | "Instagram ilovasida tasdiqlash talab qilinmoqda" | FAILED |
| PUBLISH_ACCOUNT_RESTRICTED | cheklangan | "Avval ilovadan qo'lda post qilib ko'ring" | Qo'lda |
| PUBLISH_UNKNOWN | 5xx/tarmoq | "Vaqtinchalik xato" | 30 s, 2 daq, 10 daq |
| FIRST_COMMENT_FAILED | komment | "Post chiqdi, birinchi komment yozilmadi" | 3 urinish |
| CAMPAIGN_LINK_FAILED | bog'lanmadi | "Kampaniya ulanmadi — qo'lda ulang" | Darhol + sweeper; ogohlantirish majburiy |

Idempotentlik: media_publish javobsiz → status_code; PUBLISHED bo'lsa media ro'yxatidan bog'lash.
Bildirishnomalar: post chiqdi (TG, dashboard), xato (TG, email, banner), qo'lda e'lon vaqti (TG media
bilan, email fallback), tasdiq (TG tugmalar, email), kvota 80% (TG), ertaga X post + BROKEN (hammasi).
Kuzatuv: content_publish_total{status}, latency, container_wait, kvota foizi — diagnostika kartasi.

## 12. Xavfsizlik, ruxsatlar, App Review

- `lib/meta/oauth.ts` scope'ga `instagram_business_content_publish`; callback `grantedScopes`
  yozadi; yo'q bo'lsa canPublish=false; mavjud akkauntlar "Qayta ulash" bilan.
- App Review: screencast, ruxsat matni, test foydalanuvchi, Privacy Policy media bo'limi (META_APP_REVIEW.md).
- Tenant izolyatsiyasi (boshqa workspace → 404); bucket ommaviy emas; presigned PUT 15 daq,
  Content-Type + content-length-range; kalit `ws/{workspaceId}/{yyyy}/{mm}/{cuid}.{ext}`;
  magic-byte MIME; ffmpeg ≤10 daq, sharp limitInputPixels; reviewer token 32 bayt SHA-256 7 kun;
  XSS escape; MCP faqat draft; OperationalEvent audit; 24 soatda 25+ post → ogohlantirish.

## 13. Qabul mezonlari

AC-1 JPEG feed post 19:00 → 19:00:00–19:01:00 chiqadi, PUBLISHED + permalink. AC-2 5 elementli
karusel (3 rasm + 2 video), har rasmda user tag. AC-3 45 s Reels, muqova, share_to_feed=false,
hammuallif. AC-4 3 story seriyasi 1 daqiqa oraliq. AC-5 Link stikerli story NEEDS_MANUAL →
Telegram → PUBLISHED_MANUAL. AC-6 Birinchi komment ≤30 s. AC-7 Kampaniya bilan chiqadi; 1 daqiqa
ichida keyword komment DM oladi. AC-8 Worker o'chirilsa sweeper ≤2 daq, dublikat yo'q. AC-9
media_publish timeout → faqat 1 marta. AC-10 Token BROKEN → chiqmaydi, ogohlantirish; qayta
ulangach chiqadi. AC-11 2300 belgi, 31 hashtag, 3:1 rasm, 62 s story — aniq xato. AC-12 PNG/HEIC
→ JPEG; 4K 80 Mbps transkod. AC-13 OPERATOR yaratadi, rejalashtira olmaydi; MANAGER tasdiqlaydi.
AC-14 Boshqa workspace ID → 404. AC-15 Mavjud regressiya testlari o'tadi.

Testlar: Unit (Zod matritsasi, hisoblagichlar, timezone, kvota, statuslar, xato kodlari);
Integration (lib/meta/publish.ts fetch stub: FINISHED, ERROR, EXPIRED, 190, 4, 9, timeout; karusel;
komment); Worker (delayed job, sweeper, lock, idempotentlik, 15 daq); E2E staging (AC-1…7);
Security; Load (500 post/daqiqa ≤3 daq, dublikat 0).

## 14. Bosqichlar

5 faza, har biri gate bilan (asl TZ jadvali paste'da kesilgan; dasturchi rejasi
`docs/superpowers/plans/` da). Taxminan 9 hafta; mijozlarga ochilish Business Verification + App
Review'dan keyin, YaTT arizasi 0-fazada.

## 15. Xavflar

Business Verification YaTT'siz o'tmaydi (yuqori) → qo'lda e'lon hamma uchun ishlaydi; Meta hujjat
qarama-qarshiliklari → API'dan kvota, env config; video qayta ishlash serverni yuklaydi → ffmpeg
concurrency 1; server o'chsa → sweeper + 15 daq; Creator story → NEEDS_MANUAL; ombor xarajati →
30 kunlik tozalash; hammuallif qabul qilmaydi → ogohlantirish.

## Manbalar

Instagram Platform Content Publishing; Instagram API with Instagram Login — Content Publishing;
IG User Media (POST /media); Content Publishing Limit; User Insights (online_followers);
Metricool hujjatlari (Instagram, planning, stories, recurring, CSV, approval, saved texts,
SmartLinks); SocialAuto repo (README, docs/stack.md, DECISIONS.md, schema.prisma, lib/meta/oauth.ts,
lib/developer/modules.ts, Master TZ 46 va 63); SocialAuto MCP; Metricool MCP createScheduledPost.
