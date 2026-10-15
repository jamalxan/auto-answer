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

Meta qoidalari (testda shunday bo'lishi kerak, xato emas):
- Bitta kommentga faqat **bitta** private reply.
- Private reply komment yozilganidan 7 kun ichida.
- Tugma bosilmaguncha yoki mijoz yozmaguncha follow-up yuborilmaydi; oxirgi
  xabaridan 24 soat o'tsa — SKIPPED "24 soatlik oyna yopilgan".
