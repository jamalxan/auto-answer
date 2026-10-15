# Developer modullarini qo'lda test qilish

Har bir modul asosiy mahsulotga qo'shilishidan oldin shu ssenariylardan
o'tishi kerak (Master TZ, 64-bo'lim). Avtomatik testlar (`npm test`) mantiqni
tekshiradi; bu yerdagilar esa real Instagram bilan oxirigacha ishlashini.

## 0. Tayyorgarlik

1. Serverda `.env` ichida:
   - `DEVELOPER_EMAIL=...`
   - `DEVELOPER_PASSWORD_HASH=...` — `node scripts/hash-developer-password.mjs` chiqaradi.
2. Migratsiya: `npx prisma migrate deploy` (deploy jarayoni buni o'zi qiladi).
3. `web` va `worker` qayta ishga tushiriladi (worker trigger engine'ni ham ishlatadi).
4. Oddiy akkaunt bilan SocialAuto'ga kiring, so'ng `socialauto.uz/developer/login`.
5. Test uchun **ikkinchi** Instagram akkaunt kerak (komment yozadigan "mijoz").

`TRIGGER_ENGINE_DISABLED=1` — favqulodda o'chirish: engine to'xtaydi, production
avvalgidek ishlaydi.

## ETAP 1 — Foundation (`/developer/foundation`)

| # | Qadam | Kutilgan natija |
|---|---|---|
| F1 | "Ulanishlar" tabini oching | Har bir akkaunt holati (CONNECTED / EXPIRING / …) va izohi |
| F2 | "Qayta tekshirish" | Holat yangilanadi, vaqt "hozirgina" bo'ladi |
| F3 | "Qayta ulash" → Instagram'da ruxsat bering | `/developer/foundation?connected=true` ga qaytadi, holat CONNECTED |
| F4 | Instagram sozlamalarida ilovani o'chiring, keyin F2 | RECONNECT_REQUIRED, "Qayta ulash" tugmasi |
| F5 | "Diagnostika" — har bir qatorni bosing | Status / Nima degani / Oxirgi tekshiruv / Muammo / Tavsiya |
| F6 | "Navbat" | Queued / Processing / Completed / Failed, taxminiy vaqt, soatlik limit |
| F7 | "Xatolar" | Texnik kod emas: Muammo / Sabab / Yechim |

## ETAP 2 — Comment Automation 2.0 (`/developer/comments`)

Avval test akkauntdagi production kampaniyalari shu postga javob bermasligini
yodda tuting: Comment 2.0 javob beradigan kommentni production o'tkazib yuboradi.

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| C1 | Kampaniya: bitta post, intent "Narx", 3 ta DM varianti, ochiq javob yoqilgan | Saqlanadi, ro'yxatda statistika 0 |
| C2 | "Test" bo'limida `Нархи канча?` | Mos keldi: INTENT, qaysi variant ketishi ko'rinadi |
| C3 | Mijoz akkauntdan postga `narxi qancha` yozadi | Kommentga ochiq javob + Direct'ga bitta xabar. Loglarda SENT |
| C4 | Xuddi shu komment uchun webhook qayta kelsa (yoki polling topsa) | Ikkinchi DM **yo'q** |
| C5 | Uch xil mijoz komment yozadi, rejim SEQUENTIAL | Variantlar navbat bilan |
| C6 | AI bilan yaratish → 3 ta → tahrir → tasdiqlash | Tasdiqlanmaganlari "Tasdiqlanmagan" belgili va yuborilmaydi |
| C7 | Tugma + asosiy xabar + quick reply (Manzil / Raqam / Operator) | DM'da tugma; bosilganda asosiy xabar va quick reply'lar |
| C8 | "Raqam" quick reply | Telefon kontaktga yoziladi, lead belgilanadi, follow-up to'xtaydi |
| C9 | "Operator" quick reply | Telegram'ga xabar, follow-up to'xtaydi |
| C10 | Follow-up 2 daqiqa, mijoz tugmani bosadi, javob yozmaydi | 2 daqiqadan keyin follow-up keladi |
| C11 | Follow-up oldidan mijoz javob yozadi (stop on reply) | Follow-up CANCELLED, sababi ko'rinadi |
| C12 | "Eski kommentlar", 3 kun | Hisob-kitob: topildi / yuborildi / takror / mos emas / eskirgan |
| C13 | Kampaniyani o'chirib qo'yish (Faol = off) va komment | Comment 2.0 javob bermaydi; production kampaniya bo'lsa, u javob beradi |
| C14 | `TRIGGER_ENGINE_DISABLED=1` bilan C3 | Production avvalgidek ishlaydi |

## ETAP 3 — Instagram Automation (`/developer/triggers`)

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| T1 | Direct: keyword "narx", 2 ta variant + quick reply. Mijoz Direct'ga `narxi qancha` yozadi | Bitta javob, ostida quick reply'lar. Assistent yoki eski DM-kampaniya **javob bermaydi** |
| T2 | O'sha mijoz 1 soatdan keyin yana yozadi (cooldown 24 soat) | Bu kampaniya qayta javob bermaydi |
| T3 | Audience "Yangi mijoz" — avval yozgan va hech yozmagan ikki akkaunt | Faqat yangisiga javob |
| T4 | Audience "Qayta ochildi", 1 soat qilib qo'ying; 1 soatdan keyin yozing | Javob keladi |
| T5 | Story Mention kampaniyasi; mijoz story'da akkauntni belgilaydi (public akkaunt) | Direct'ga javob |
| T6 | Click-to-Direct reklama (ad id bilan) | Reklamadan kelgan xabarga javob, loglarda "Reklama: <ad id>" |
| T7 | ig.me havola (ref=bio), akkauntda Icebreakers yoqilgan, telefondan oching | Javob, loglarda "Havola: bio" |
| T8 | Live kampaniya; efirda `narx` deb komment | Bitta private reply. Efirdan keyingi komment — FAILED "Efir tugagan…" |
| T9 | Story'ga reaksiya bosing (❤️) | Loglarda "Reaksiya" qatori, **javob yo'q** — kuzatuv rejimi. Shu qatorni menga yuboring: story reaksiyasini yoqish shu ma'lumotga bog'liq |
| T10 | Kommentdan boshlangan suhbat (C3) davom etayotganda Direct'da `narx` | Direct trigger jim turadi — ikki bot birdan gapirmaydi |

## ETAP 4 — JavobAI (`/developer/javobai`)

Avval "Akkauntlar" tabida test akkaunt uchun **SHADOW** rejimini yoqing: production
javob beradi, JavobAI esa o'z javobini "Shadow" tabida yonma-yon ko'rsatadi.
Bir necha kun kuzatib, keyin **LIVE**ga o'tkazing. `JAVOBAI_DISABLED=1` — hammasini
production'ga qaytaradi.

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| J1 | "Test" tabida "Scenario B" tugmasi | narx → javob (KB'dan, used facts ko'rinadi) → saralash savoli → telefon → lead 🔥 → handoff |
| J2 | "Test" tabida "Scenario C" | "menejer bilan gaplashmoqchiman" → handoff, sabab `wants_human` |
| J3 | Sandbox'da KB'da yo'q narx so'rang ("Mercedes qancha?") | "Bu ma'lumot menda yo'q…", `blockedBy`/unknown ko'rinadi, bilim bo'shlig'i yoziladi; 2-marta → handoff |
| J4 | SHADOW: mijoz Direct'ga `narxi qancha` yozadi | Production javob beradi; "Shadow" tabida ikkala javob, confidence va score |
| J5 | LIVE: xuddi shu | JavobAI javob beradi, ostida mahsulot tavsiyasi/savol; production jim |
| J6 | LIVE: mijoz telefon yozadi | Telegram/CRM'ga lead "🧪 TEST · 🔥 HOT 72" bilan; "Suhbatlar"da lead va score events |
| J7 | LIVE: mijoz "olaman" deydi | Telefon so'raladi, olgach darhol handoff; Telegram'da "Qabul qildim / Yopish" tugmalari |
| J8 | Telegram'da "Qabul qildim" | Suhbat OPERATOR_ACTIVE, AI jim; operator yozsa ham AI gapirmaydi |
| J9 | Telegram'da "Yopish" → mijoz yana yozadi | AI qayta javob beradi, oldingi xulosani eslaydi (MIJOZ HAQIDA) |
| J10 | "Bilim bazasi"da chegirma yozuvi qo'shing, tasdiqlamang → sandbox'da chegirma so'rang | AI chegirmani aytmaydi; tasdiqlagach aytadi |
| J11 | Uch tilda: `Narxi qancha?` / `Нархи канча?` / `Сколько стоит?` | Bir xil intent, javob mijoz yozuvida (lotin/kirill/rus) |
| J12 | Ovozli xabar (uz/ru) | Loglarda "🎤 …" transkript, javob matn bo'yicha; sifatsiz bo'lsa "yozib yuboring" |
| J13 | Mahsulot rasmi | Katalogdan topsa narx siyosati bo'yicha javob, topmasa savol/handoff |
| J14 | "Xarajat" tabida byudjet 1$ qo'ying, sandbox'ni ishlating | 50/80/100% Telegram ogohlantirish, 100%da LIVE "AI vaqtincha o'chirilgan" + handoff |
| J15 | Kommentdan boshlangan suhbat (C7) davomida Direct'da savol | JavobAI jim turadi — trigger oqimi egalik qiladi |

Meta qoidalari (testda shunday bo'lishi kerak, xato emas):
- Bitta kommentga faqat **bitta** private reply.
- Private reply komment yozilganidan 7 kun ichida.
- Tugma bosilmaguncha yoki mijoz yozmaguncha follow-up yuborilmaydi; oxirgi
  xabaridan 24 soat o'tsa — SKIPPED "24 soatlik oyna yopilgan".
- Live kommentga private reply faqat efir davomida.
- Story mention faqat public akkauntdan (yoki sizga obuna bo'lgan yopiq akkauntdan) keladi.
- ig.me ref yangi suhbatda faqat Icebreakers sozlangan bo'lsa keladi; Instagram Web'da ishlamaydi.
