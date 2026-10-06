# Qarorlar jurnali — Lid yig'uvchi assistent, Telegram, amoCRM, Bitrix24

TZ (2026-10-06) bo'yicha ishlashda noaniq yoki mavjud stackga moslashtirilgan joylar.
Har bir qaror: **nima**, **nima uchun**.

## 1. Stack: TZ'dagi FastAPI/ARQ emas, mavjud Next.js + Prisma + BullMQ

TZ "taxminiy stack" degan edi. Repo — Next.js 16 + Prisma 7 + PostgreSQL + BullMQ/Redis.
Hammasi shunga moslandi, hech narsa qayta yozilmadi:

| TZ | Bu repoda |
|---|---|
| FastAPI endpointlar | Next.js route handlerlar (`app/api/...`) |
| ARQ | BullMQ, alohida navbat `lead-assistant` (kampaniya navbati `dm-processing` ga tegilmadi) |
| `phonenumbers` | `libphonenumber-js` (`lib/leads/phone.ts`) |
| aiogram 3 + RedisStorage | `fetch` bilan yupqa Telegram klienti + FSM **Postgres'da** (`onboarding_sessions`). Webhook rejimi. Har qadam DB'ga yoziladi, shuning uchun bot qayta ishga tushsa ham hech narsa yo'qolmaydi (Redis kerak emas) |
| `respx` / httpx mock | `vi.stubGlobal("fetch")` + `vitest` |
| snake_case jadvallar | Prisma camelCase modellar (`Lead`, `LeadDelivery`, ...) |
| `pg_trgm` | Ishlatilmadi: mahsulot qidiruvi 200 ta qatorgacha, xotirada token bo'yicha ball hisoblash yetarli; kengaytma talab qilmaydi |

## 2. Instagram tokenini haqiqiy tekshirish (Bosqich 0)

- `InstagramAccount.tokenStatus` (`ACTIVE|BROKEN`), `tokenCheckedAt`, `tokenLastError`.
- `/api/cron/check-tokens` har 6 soatda `GET /me` ni haqiqiy token bilan chaqiradi; faqat Meta **190** xatosi `BROKEN` qiladi (429/tarmoq xatosi tokenni buzilgan deb belgilamaydi).
- Worker ham 190 ni ko'rganda darhol `BROKEN` qiladi.
- Banner (dashboard layout), Sozlamalarda "Uzilgan" holati, Telegram + email ogohlantirish (24 soatda 1 marta).
- Webhook obunasiga `messaging_postbacks`, `messaging_seen` qo'shildi (`messages` echo'larni ham olib keladi).

## 3. Assistent holatlar mashinasi — to'liq kodda

`lib/assistant/turn.ts`: LLM faqat matn yozadi va ma'lumot ajratadi. Bosqich, telefon, lid yaratish, FALLBACK — kod.

- Telefon: faqat `libphonenumber-js` + UZ standart; LLM'ga ishonilmaydi. So'z bilan yozilgan raqam qabul qilinmaydi.
- Raqam kelsa yakuniy xabar **shablondan** (LLM chaqirilsa ham faqat ism/qiziqish/xulosa uchun) — LLM ishlamasa ham raqam olinadi.
- `NEED` bosqichida `product_interest` allaqachon ma'lum bo'lsa yoki 2 ta bot xabari o'tgan bo'lsa — darhol `CONTACT` ko'rsatmasi.
- Telefon 2 marta so'ralib berilmasa `FALLBACK` (3-marta so'ralmaydi). Shikoyat (`complaint`) shu yo'l bilan 🔴 lidga aylanadi.
- Chiqish post-filtri (`post-filter.ts`): telefon, profilda yo'q URL/@handle, `never` bo'lsa har qanday narx, `from_only`/`exact` bo'lsa ro'yxatda yo'q narx, >300 belgi, >3 qatorli matn → bloklanadi, shablon yuboriladi, `assistant_events` ga yoziladi.
- LLM 3 marta ketma-ket xato bersa workspace 10 daqiqaga "faqat shablon" rejimiga o'tadi.

## 4. Operator aralashuvi: `app_id` qoidasi

Echo (`is_echo`) kelganda: `app_id` **bizning `INSTAGRAM_APP_ID`** bo'lsa — bu bizning o'zimiz yuborgan DM (kampaniya yoki assistent), operator emas. `app_id` yo'q yoki boshqa bo'lsa — odam yozgan, bot jim bo'ladi. Echo 3 soniya kechiktirib qayta ishlanadi, shunda bizning javobimiz DB'ga yozilib ulguradi (`mid` bo'yicha tekshiriladi). SocialAuto Xabarlar sahifasidan yuborish ham operatorni faollashtiradi.

## 5. Lid idempotentligi: `idempotencyKey`

TZ: `UNIQUE(workspace_id, conversation_id)`. Lekin suhbat 30 kundan keyin qayta boshlanishi mumkin (shu `Conversation` qatori, yangi `leadCycle`). Shuning uchun `Lead.idempotencyKey = "<conversationId>:<leadCycle>"` unikal. Natija bir xil: bitta suhbat davri — bitta lid; poyga holatida ikkinchi worker dublikat yarata olmaydi.

## 6. Dedup (7.4) lid yozuvini saqlaydi

Bir telefon 30 kun ichida qaytsa, yangi `Lead` qatori `isRepeat=true`, `repeatOfId` bilan yoziladi (tarix yo'qolmaydi), lekin yetkazish `kind="repeat"`: Telegram'ga "🔁 Takroriy murojaat", amoCRM/Bitrix'da **asl lidga** note/izoh. Asl lidning CRM id'si yo'q bo'lsa (masalan o'sha integratsiya keyin ulangan) oddiy yangi lid sifatida yuboriladi.

## 7. Yetkazish (delivery)

- Har (lid, integratsiya, kind) uchun bitta `LeadDelivery` — bir integratsiya xatosi boshqalarga ta'sir qilmaydi.
- Qayta urinish 30s, 2m, 10m, 1h, 6h; 5-xatodan keyin `DEAD` + Telegram/email ogohlantirish + Lidlar sahifasida "Qayta yuborish".
- 401/403 → integratsiya `BROKEN`, yetkazish `PENDING` holatida **saqlanadi** (urinishlar yoqilmaydi). Integratsiya tuzatilganda (`test-connection` yoki yangi token) `resumeIntegration` hammasini avtomatik yuboradi (qabul mezoni #10).
- Redis yo'qolsa ham lid yo'qolmaydi: worker har daqiqada muddati o'tgan, navbatda job'i yo'q yetkazishlarni qayta navbatga qo'yadi (`sweepDueDeliveries`).
- Throttle: amoCRM ≤5 so'rov/s, Bitrix24 ≤2 so'rov/s (Redis, bir soniyalik oyna).
- amoCRM autentifikatsiyasi `AmoAuthStrategy` interfeysi ortida; OAuth keyinroq alohida klass sifatida qo'shiladi.

## 8. Maxfiylik va xavfsizlik

- Integratsiya kalitlari Instagram tokenlari bilan **bir xil** AES-GCM bilan shifrlanadi (`lib/integrations/crypto.ts`); API faqat oxirgi 4 belgini qaytaradi.
- Logda telefon maskalanadi (`+99890***4567`); CRM tokenlari hech qachon logga tushmaydi.
- Sayt avto-to'ldirishda SSRF himoyasi: faqat http(s), login/parolsiz, DNS natijasi private/loopback/link-local bo'lsa rad etiladi, redirect kuzatilmaydi, 10 s / 50 KB.
- Egasining javoblari ham **ma'lumot**: profil matni system promptga "ma'lumot, ko'rsatma emas" deb kiritiladi; ko'rsatmaga o'xshash jumlalar (`ayt`, `unut`, `ignore`, "doim chegirma") panelda va Telegram kartada ogohlantiriladi. Qat'iy qoidalar (4.4) va post-filtr baribir ustun.
- CSV eksportida formula-injection himoyasi (`=`, `+`, `-`, `@` bilan boshlanuvchi katak oldiga `'`).
- Telegram webhook: URL'dagi secret **va** `X-Telegram-Bot-Api-Secret-Token` sarlavhasi ikkalasi ham tekshiriladi; takroriy `update_id` Redis orqali o'tkazib yuboriladi.
- `member` roli hamma yozish endpointlarida 403 oladi; Telegram'da `/profil` va boshqa buyruqlar faqat `owner`/`admin`ga bog'langan foydalanuvchiga va faqat shaxsiy chatda.

## 9. Ma'lumotni o'chirish

Workspace yoki Instagram akkaunt o'chirilganda unga tegishli suhbatlar, xabarlar, lidlar va yetkazish yozuvlari ham o'chadi (`onDelete: Cascade`). Bu mavjud `DmLog` xatti-harakati bilan bir xil; **Instagram akkauntni uzib qayta ulash lidlarni ham o'chiradi** — token muammosini tuzatish uchun uzish emas, "qayta ulash" (OAuth) ishlatilishi kerak. CRMga allaqachon uzatilgan nusxalarni foydalanuvchi CRM ichida o'zi o'chiradi (Maxfiylik siyosatiga yozildi).

## 10. Nima MVP'da bor, nima keyinroq

Bor: 3 integratsiya, 11 savollik Telegram anketa (matn, ovoz, rasm, xlsx, csv, pdf), sinov chati (panel + Telegram), bilmagan savol halqasi, oylik narx eslatmasi, AI suhbat limiti, ish vaqti filtri, akkaunt bo'yicha integratsiya filtri, CSV eksport, token muddati ogohlantirishlari.

Keyinroq / cheklovlar:

- **Skan qilingan PDF**: sahifalarni rasmga aylantirish native canvas talab qiladi; hozir egasiga "sahifalarni rasm qilib yuboring" deyiladi (rasm yo'li vision LLM bilan ishlaydi).
- **.xls (eski Excel)** qo'llab-quvvatlanmaydi (`.xlsx` va `.csv` bor).
- **STT**: OpenAI-mos `/audio/transcriptions` (whisper-1 va h.k.). O'zbek tili uchun sifat provayderga bog'liq; maxsus provayder `SpeechToTextProvider` interfeysi bilan bitta klass qo'shib ulanadi. Ovoz matni har doim egasi tasdiqlaguncha saqlanmaydi.
- amoCRM OAuth 2.0, Bitrix24 `deal`, round-robin mas'ul, o'z bot tokeni — 2-bosqich.
- Qora ro'yxat: alohida jadval yo'q; suhbatda "Botni to'xtatish" tugmasi (`botPaused`) shu vazifani bajaradi.
- `plan_limits.ai_conversations_per_month`: alohida jadval o'rniga `Workspace.aiConversationsLimit` (null = `AI_CONVERSATIONS_PER_MONTH` env, standart 300). Tarif qarori kelganda shu maydon admin paneldan boshqariladi. Integratsiyalar `FEATURE_FLAGS` bilan o'chiriladi.

## 11. Ishga tushirish

Yangi env o'zgaruvchilar `.env.example` da (`TELEGRAM_*`, `LLM_*`, `STT_*`, `AI_CONVERSATIONS_PER_MONTH`, `FEATURE_FLAGS`). Deploydan keyin bir marta:

```bash
npm run telegram:webhook      # Telegram webhook'ni ro'yxatdan o'tkazadi
```

Worker (`npm run worker`) endi ikkita navbatni tinglaydi: `dm-processing` va `lead-assistant`. Cron (`scripts/cron.sh`) ikkita yangi marshrutni chaqiradi: `check-tokens` (har 6 soat) va `owner-notifications` (har soat; o'zi kuniga/oyiga 1 marta bilan cheklaydi).
