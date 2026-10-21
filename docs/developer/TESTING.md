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

## ETAP 5 — CRM / Lead Management (`/developer/crm`)

CRM faqat `CRM_ENABLED=1` bilan ishlaydi (web va worker'ga qo'ying, keyin
qayta ishga tushiring): bu o'zgaruvchisiz hooklar, worker, reconciler va
broadcast o'chiq, production avvalgidek ishlaydi. Avval "Umumiy" tabida
**Backfill**'ni bir marta ishga tushiring (fon vazifasi sifatida navbatga
qo'yiladi): InstagramContact, Conversation, Lead va DmLog'dagi har bir odam
uchun bitta CrmContact yaratiladi; tarixiy yozuvlar uchun Telegram xabarlari
va avtomatik biriktirish ishlamaydi. Reconciler birinchi ishga tushganda
"hozir"dan boshlaydi — tarix faqat Backfill orqali. `CRM_DISABLED=1` —
favqulodda o'chirish, `CRM_ENABLED=1` dan ustun turadi. Broadcast uchun test "mijoz" akkaunt
sizga oxirgi 24 soat ichida yozgan bo'lishi kerak (Meta 24 soatlik oynasi).

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| K1 | "Umumiy" → Backfill | "Navbatga qo'yildi" (202); bir necha daqiqadan keyin "Kontaktlar"da to'rt jadvaldagi har bir odam bittadan, takror yo'q; Telegram'ga eski leadlar haqida xabar kelmaydi; qayta bosilsa son o'zgarmaydi. CRM_ENABLED=1 bo'lmasa — 409 "CRM o'chiq" |
| K2 | C7 kontaktini oching (komment → javob → DM → AI javob → lead → yetkazish) | Timeline shu tartibda, yangisi tepada; "Eskilarini yuklash" keyingi sahifani qo'shadi; bitta xabar ikki marta chiqmaydi |
| K3 | "Segmentlar" → yangi: Teg HOT + Telefon bor + custom.city = Toshkent + custom.course ichida IELTS | Preview soni = "Kontaktlar" tabida shu segment tanlanganda chiqadigan son; jumla: "Teg: HOT va Telefon bor va city = Toshkent va course ichida \"IELTS\"" |
| K4 | "Kontaktlar" → CSV eksport (segment tanlangan holda) | Qatorlar soni = preview soni; VIEWER / OPERATOR uchun tugma yo'q, URL'ga kirsa 403 |
| K5 | TZ §63 zanjiri: komment → javob → telefon chipi → Lead | "Pipeline"da bitim "Yangi lead" ustunida; Telegram'da "Bog'lanildi" → "Bog'lanildi" ustuniga ko'chadi |
| K6 | Kanban'da bitimni "Yutildi"ga sudrang (yoki "Ko'chirish…") | Kontakt holati Mijoz, JavobAI harorati CUSTOMER; "Yo'qotildi"ga — sabab so'raladi, harorat LOST; qaytarilsa ball qaytadan hal qiladi |
| K7 | "Jamoa" → qoida: HOT bo'lganda → navbat bilan (ikki operator) → ikki kontakt HOT bo'ladi | Birinchisi 1-operatorga, ikkinchisi 2-operatorga; workspace Telegram chatida xabar + "Qabul qildim / Bo'shatish" tugmalari |
| K8 | Telegram'da boshqa a'zo "Qabul qildim" bosadi | Kontakt o'sha a'zoga biriktiriladi (timeline'da "Operator biriktirildi"); "Bo'shatish" — operator faqat o'zinikini bo'shata oladi |
| K9 | VIEWER rolidagi a'zo bilan kiring | Hamma tab o'qiladi; status / teg / eslatma / biriktirish / segment / broadcast tugmalari yo'q; API'ga PATCH/POST yuborilsa 403 |
| K10 | "Broadcast" → 3 kishilik segment: 1 soat oldin yozgan, 2 kun oldin yozgan, "STOP" yozgan | Preview: 1 yuboriladi, "24 soatlik oyna yopilgan: 1", "Obunadan chiqqan: 1"; "Hozir yuborish" → aynan bitta DM; qabul qiluvchilar ro'yxatida ikkita sabab |
| K11 | Broadcast olgan mijoz 48 soat ichida javob yozadi; 7 kun ichida bitimi "Saralangan"ga ko'chiriladi | Detailda "Javob berdi" 1, "Konversiya" 1; kontakt timeline'ida "Broadcast'ga javob berdi" va "Broadcast konversiyasi" |
| K12 | Mijoz "STOP" / "to'xtating" / "Отпишите" yozadi; keyingi broadcast | Kontakt kartasida "Obunadan chiqqan (STOP yozgan)", timeline'da OPT_OUT; keyingi broadcastda sabab "Obunadan chiqqan"; "Obunaga qaytarish" qaytaradi |

Broadcast qoidalari (testda shunday bo'lishi kerak, xato emas):
- Odam yozmagan yoki oxirgi xabaridan 23 soat 55 daqiqa o'tgan bo'lsa — yuborilmaydi, sababi ko'rinadi.
- Operator bilan suhbatdagilar (handoff kutilmoqda / operator yozmoqda) o'tkazib yuboriladi (egasi qarori 2).
- 24 soat ichida boshqa broadcast olgan odam "Yaqinda broadcast olgan" (chastota chegarasi 0 bo'lsa — yuboriladi).
- Soatiga N: har 5 daqiqada floor(N/12) ta; akkauntning 750/soat limiti tugasa bir soat kutiladi, hech kim o'tkazilmaydi.
- "To'xtatish" keyingi yuborishdan oldin ishlaydi; "Bekor qilish" navbatdagilarni "O'tkazildi" qiladi.
- Worker yuborish o'rtasida o'lsa (10 daqiqadan eski "Yuborilmoqda") — "Xato: jarayon uzildi", qayta yuborilmaydi.

## ETAP 6/7 — Flow Builder + AI Flow Builder (`/developer/flows`)

Flow'lar `FLOWS_DISABLED` qo'yilmagan bo'lsagina ishlaydi (web va worker'da). Ishga tushirilgan oqim
yashirin "proxy" kampaniya orqali Comment 2.0 / Direct kampaniyalar bilan bir xil egalik qoidasidan o'tadi
(bitta xabarga bitta egasi). Qarorlar: faqat **AI yaratgan** versiya tasdiqsiz ishga tushmaydi (qo'lda
qurilgan oqim to'g'ridan-to'g'ri chiqadi); Story Reply V1 oqimlarga kirmaydi. AI qoralama soatiga 10 tagacha
(workspace bo'yicha), `JAVOBAI_MODEL_SMART` bilan, AI byudjetiga hisoblanadi (`javobai_flowbuilder`).
Haqiqiy sinov uchun test Instagram akkaunt sizga oxirgi 24 soat ichida yozgan bo'lishi kerak.

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| F1 | "Shablonlar" → "Komment → narx → telefon → lead" → Ko'rish → Nusxa olish | Yangi oqim "Qoralama"; bloklar ro'yxati va telefon ko'rinishi shablondagidek; Audit tabida 0 xato; CRM'da shablonning teglari bor; asl shablon o'zgarmagan |
| F2 | Komment oqimining birinchi xabaridan tugmani olib tashlang va undan keyin yana xabar qo'shing → Saqlash → Audit / Nashr | Policy BLOCKED ("birinchi xabarda tugma yo'q"), sababi o'zbekcha, blok id'si bosilsa o'sha blokka o'tadi; "Ishga tushirish" tugmasi o'chiq; API ham 422 qaytaradi |
| F3 | "AI bilan yaratish": TZ §39 so'rovi ("narx" kommentiga javob, telefon so'rash, lead + Telegram) → Yaratish → Qoralama sifatida saqlash → Test → Nashr tabida tasdiqlash → Ishga tushirish | Oldin preview + PASS/WARNING; saqlangach Test va tasdiq bo'lmaguncha "Ishga tushirish" yopiq ("AI yaratgan versiya tasdiqsiz ishga tushmaydi"); matnni o'zgartirsangiz test va tasdiq bekor bo'ladi; tasdiqlangach versiya ishga tushadi, holat "Ishlayapti" |
| F4 | Haqiqiy akkauntda: ishga tushirilgan oqim → postga "narx" komment → Direct'dagi tugmani bosing → telefon yuboring | Komment ostida ochiq javob + shaxsiy xabar tugma bilan; tugmadan keyin keyingi xabar; telefon → Lead (Telegram'ga xabar, CRM'da bitim); "Ishga tushishlar"da bitta yozuv "Tugadi", qadamlari to'liq |
| F5 | Delay 25 soat + undan keyin xabar bo'lgan oqim; Test'da "oyna yopiq"; haqiqiyda tugmani bosib 24 soat kuting | Test: oqim `end` bilan tugaydi, xabar yuborilmaydi; haqiqiyda 24 soatdan keyin hech narsa ketmaydi, run "Tugadi" (sabab: oyna yopilgan) |
| F6 | v1 ishga tushgan, kutayotgan mijoz bor → v1'ni tahrirlab saqlang (v2 ochiladi) → v2'ni ishga tushiring | Kutayotgan mijoz v1 bo'yicha tugaydi; yangi mijozlar v2 bo'yicha; "Versiyalar"da v1 "Eski", v2 "Ishlayapti"; "Solishtirish" o'zgargan matnni eski → yangi ko'rsatadi; v1'ni "Qoralama sifatida tiklash" yangi qoralamani ochadi |
| F7 | Kutayotgan (tugma kutilmoqda) run bor oqimni "To'xtatish (qoralamaga)" | Inline tasdiq kutayotganlar sonini aytadi; oqim "Qoralama"; kutayotgan runlar keyingi sweep'da "Bekor qilindi"; shu mijoz tugmani bossa javob ketmaydi; Comment 2.0 kampaniyasi avvalgidek ishlaydi |
| F8 | "Kengaytirilgan" rejim: Shart bloki (masalan: teg HOT bo'lsa → lead, bo'lmasa → operator), bloklarni sudrang, "Avto-joylash", chiqish nuqtasini bosib maqsad blokni bosing, bog'lanishni tanlab o'chiring → Saqlash → Nashr | Tarmoqlar kanvasda ko'rinadi, joylashuv saqlanadi (sahifani yangilang — joyida); "Oddiy" rejimga o'tganda graf bir xil; Test'da shart ikki holatda ham to'g'ri tarmoqqa boradi; oqim ishga tushadi |
| F9 | Webhook blokida manzil: `http://…`, `https://localhost/…`, `https://10.0.0.5/…` | Audit/Policy: BLOCKED ("faqat https", "ichki manzil"), Nashr yopiq; haqiqiy https manzil — nashr mumkin; ruxsat ro'yxati yo'qligi ogohlantirish (ETAP 8 gacha) |
| F10 | Serverda `FLOWS_DISABLED=1`, web va worker'ni qayta ishga tushiring | /developer/flows ochiladi, qizil ogohlantirish; "Ishga tushirish" 503; yangi komment / xabar oqimlarni boshlamaydi, Comment 2.0, Direct va JavobAI avvalgidek; qaytarib qayta ishga tushirsangiz hammasi qaytadi |

Eslatmalar:
- Test konsoli — sandbox: Instagram'ga hech narsa yuborilmaydi, lead / teg yaratilmaydi; "Haqiqiy ishda nima bo'lardi" bo'limi faqat ko'rsatadi.
- Saqlash qoralamani joyida yangilaydi; ishga tushirilgan versiyadan keyingi saqlash yangi versiya ochadi. Faqat joylashuv (kanvasda sudrash) o'zgarsa, sinov va tasdiq bekor bo'lmaydi.
- AI ikki urinishdan keyin ham yaroqli oqim bermasa 422 va tavsiya matni chiqadi; AI sozlanmagan bo'lsa 503; byudjet tugagan yoki soatiga 10 tadan oshsa 429.
- Faqat qoralama yoki arxivdagi, ishga tushish tarixi yo'q oqimni o'chirish mumkin (aks holda 422).

## ETAP 8 — Integrations 2.0 (`/developer/integrations`)

Hodisa shinasi (webhook, Google Sheets, Make, Zapier, Telegram HOT karta, amoCRM /
Bitrix24 boyitish). Eski lead yetkazish (Telegram / amoCRM / Bitrix24) o'zgarmagan:
WEBHOOK / SHEETS / MAKE / ZAPIER ulanishlari hech qachon `LeadDelivery` olmaydi.
Hodisalar lead yaratilgandan 3 soniya keyin tayyorlanadi (score yozilishi uchun).
`INTEGRATIONS_BUS_DISABLED=1` — favqulodda o'chirish. Qabul qiluvchi uchun
webhook.site yoki oddiy Node serveri (https kerak — ngrok / cloudflared) yetadi;
ichki manzillar (localhost, 10.x) ataylab rad etiladi.

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| I1 | "Ulanish qo'shish → Webhook": https manzil, hodisa `lead.created`; kalit ko'rsatiladi, nusxalang; kartada "Sinash" | Qabul qiluvchida POST, `X-SocialAuto-Signature` Qo'llanmadagi Node/PHP kod bilan tasdiqlanadi; payload `is_test: true`; kartada "Yuborildi · HTTP 200"; kalit qayta ko'rsatilmaydi (faqat `••••abcd`) |
| I2 | URL: `http://…`, `https://localhost/…`, `https://10.0.0.5/…`, `https://user:pass@…` | Har biri saqlanmaydi, sababi o'zbekcha ("Faqat https://…", "Ichki yoki lokal manzillarga…") |
| I3 | Qabul qiluvchi 500 qaytaradi; "Yetkazishlar"ni kuzating | Holat "Qayta uriniladi", urinishlar 30 s / 2 daq / 10 daq / 1 soat / 6 soat; 6-urinishdan keyin DEAD + workspace Telegram'ida bitta ogohlantirish (soatiga bir marta); qabul qiluvchini tuzatib "Qayta yuborish" → Yuborildi |
| I4 | Qabul qiluvchi 410 qaytaradi | Yetkazish DEAD, ulanishdagi obuna "o'chirilgan"; 400 → darhol DEAD (qayta urinilmaydi); ketma-ket 5 ta DEAD ham obunani o'chiradi |
| I5 | Haqiqiy lead yarating (komment → telefon): `lead.created` + (HOT bo'lsa) `lead.hot` obunalari | Webhook'ga 3 soniyadan keyin bitta hodisa (payloadda score, source, teglar); takror yuborishda ham `X-SocialAuto-Event-Id` bir xil; lead sahifasidagi yetkazishlar (Telegram / amoCRM) avvalgidek |
| I6 | "Google Sheets" ulang (service account JSON + jadval havolasi), jadvalni ulashmasdan "Test qator qo'shish" | Integratsiya "To'xtagan", xabarda `client_email` bilan "Share → Editor" ko'rsatmasi; ulashib "Ulanishni tekshirish" → Faol, kutgan hodisalar o'zi ketadi; varaq yaratilgan, 1-qatorda sarlavhalar, 2-qatorda test qator (`is_test = ha`) |
| I7 | Make: Custom webhook; Zapier: Catch Hook — "Sinash" | Ikkalasida maydonlar tanildi (`lead.name`, `score.value` …); bitta hodisa — bitta ishga tushish; Make/Zapier turlari alohida kartalar |
| I8 | Telegram kartasida "HOT lead kartasi"ni yoqing; HOT lead yarating | Workspace chatida alohida karta (ism, telefon, mahsulot, ball, manba, suhbatga havola); oddiy lead kartasi ham avvalgidek; sovuq lead uchun HOT karta kelmaydi |
| I9 | amoCRM kartasida "CRM boyitish"ni yoqing (ball maydoni, bosqich → status); lead yarating, keyin CRM'da bitimni boshqa bosqichga ko'chiring | amoCRM leadida ball izohi, `hot`/`warm` teg, ball maydoni; bosqich o'zgarganda status ham o'zgaradi; boyitish lead amoCRM'ga yetgunicha kutadi (yangi lead yaratmaydi); Bitrix24'da izoh + UF maydon + STATUS_ID |
| I10 | "Kalitni almashtirish"; keyin 24 soat ichida "Sinash"; VIEWER bilan kiring | Sarlavhada ikkita `v1=` (eski va yangi kalit), ikkalasi bilan ham tasdiqlanadi; 24 soatdan keyin bitta; VIEWER hammasini ko'radi, lekin tugmalar yo'q (403), payload ko'rinmaydi |

Eslatmalar:
- "Test hodisa yuborish" (Hodisalar tabi) faqat "Test hodisalar ham" yoqilgan obunalarga boradi; kartadagi "Sinash" esa shu ulanishga to'g'ridan-to'g'ri yuboradi.
- Tezlik limiti (standart 60/daqiqa) oshsa yetkazish 1 daqiqaga surilib, urinish hisoblanmaydi.
- Hodisalar va yetkazishlar 30 kundan keyin o'chiriladi (payloadda to'liq telefon bor).

## ETAP 10 — Analitika + Observability (`/developer/analytics`)

Kampaniya / AI / Sotuv / Funnel / KPI. Hamma raqam `AnalyticsDaily` rollup'laridan
o'qiladi (Asia/Tashkent kunlari); bugun va kecha har ~10 daqiqada worker'da yangilanadi,
kechasi 00:15 da oxirgi 3 kun qayta hisoblanadi. Eski kunlar uchun KPI tabidagi
"Backfill (90 kun)". `ANALYTICS_DISABLED=1` — favqulodda o'chirish. Content scheduler
bu bosqichga kirmagan (Meta publishing ruxsatigacha kechiktirilgan).

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| N1 | KPI tabida "Backfill (90 kun)", 1–2 daqiqadan keyin Kampaniya tabini "30 kun" bilan oching | Backfill navbatga qo'yiladi (202), ikkinchi bosish "allaqachon navbatda"; 30 kunlik grafik tarixiy kunlar bilan to'ladi, bo'sh kunlar nol |
| N2 | Bitta comment kampaniyani tanlang: "7 kun" yuborilgan/bosishlar; xuddi shu kampaniyaning ochiq hisobotini (share link) oching | Taqsimotdagi "Yuborildi" va "Bosishlar" hisobotning 7 kunlik yig'indisi bilan teng |
| N3 | "Bugun" / "7 kun" / "30 kun" / "Maxsus" (o'tgan hafta) + "Oldingi davr bilan" | Bugun va 7/30 kunda "kun hali tugamagan" ogohlantirishi; maxsus o'tgan oraliqda yo'q; kartalarda oldingi davr va ±% farq; 366 kundan uzun oraliq xato beradi |
| N4 | Tashkent yarim tunida (19:00 UTC) yuborilgan DM'ni kuzating (yoki test yozuv: `createdAt` 19:30Z) | Yozuv keyingi Toshkent kuniga tushadi, UTC kuniga emas |
| N5 | Test lead yarating (sandbox) va haqiqiy lead; "Bugunni qayta hisoblash" (KPI tabi) | Faqat haqiqiy lead "Lidlar"da; test lead va boshqa workspace hisoblanmaydi; qayta hisoblash ikki marta bosilsa raqamlar ikki baravar bo'lmaydi |
| N6 | Funnel tabi: "Davr" va "Kogorta" rejimlari | Davr: Kommentlar → DM → Javoblar → Lidlar → Hot → Sotuvlar, bosqich orasida yo'qolish %; sarlavhada "SocialAuto ko'rgan kommentlar"; qo'lda "Mijoz" qilinganlar alohida qator. Kogorta: aynan shu odamlar bosqichma-bosqich (har bosqich oldingisining qismi) |
| N7 | KPI tabi: Redis'ni to'xtating (yoki worker'ni) va sahifani yangilang | Sahifa ochiladi; Redis'ga bog'liq kartalar "yuklab bo'lmadi", qolganlari ishlaydi; navbat chuqurligi "butun platforma" deb belgilangan; worker kartasi "To'xtagan" |
| N8 | Worker'ni 3 daqiqa to'xtating (web ishlab tursin) | `scripts/cron.sh` har 5 daqiqada `analytics-rollup?task=alerts` chaqiradi → Telegram'da "Worker ishlamayapti" (6 soatda bir marta); Meta xatosi >20% (≥10 urinish/15 daq), DM navbati >60 daq, webhook kechikishi >5 daq, AI xatosi >30% (≥5 chaqiruv) ham shunday; qoidalar ro'yxatida "Oxirgi: …" ko'rinadi |

Eslatmalar:
- "Qabul qilindi (Meta)" v1 da "Yuborildi" bilan teng (Meta yetkazib berish kvitansiyasini alohida bermaydi).
- "AI hal qildi" qat'iy: lid yig'ilgan va suhbatda hech qachon operatorga topshirish bo'lmagan.
- "Javoblar": trigger'larda mijozning birinchi xabari (`firstInboundAt`); bu maydon qo'shilishidan oldingi yozuvlarda "ochilgan" vaqti ishlatiladi.

## ETAP 9 — Engagement (`/developer/engagement`)

Giveaway (komment → qatnashchi → commit → qur'a → tasdiq → xabar), Referral va Gamification.
`ENGAGEMENT_DISABLED=1` — favqulodda o'chirish (sahifada qizil ogohlantirish chiqadi). Sinov uchun
Instagram akkaunt, 24 soatlik oyna ochiq va yopiq ikkita test odam, Telegram ulangan workspace kerak.

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| E1 | Giveaway tabida "Yangi giveaway": akkaunt → postni tanlang (rasm), qoidalar, davr (7 kun), 1 g'olib + 2 zaxira → "Qoralama sifatida saqlash" → "Faollashtirish" | Qoralama saqlanadi (sarlavhada "Saqlanmagan o'zgarishlar" saqlashdan keyin yo'qoladi); bosqichlar DRAFT → Faol; faollashtirishdan keyin "Tahrirlash" tugmasi yo'q (qoidalar qotadi); Viewer/Operator'da "Yangi giveaway" tugmasi ko'rinmaydi |
| E2 | Test odam postga izoh yozadi; sahifani 1 daqiqa kuzating (15 s da o'zi yangilanadi) | Izoh ≤ 1 daqiqada ishtirokchilar jadvalida (holat, tekshiruvlar, izoh vaqti); "Ishtirokchi" hisoblagichi 1 ga oshadi |
| E3 | Xuddi shu odam yana 2 ta izoh yozadi | Yangi qator qo'shilmaydi: bitta ishtirok, "3 ta izoh (bitta ishtirok)" belgisi; eligible soni o'zgarmaydi |
| E4 | "Do'stlarni belgilash" (kamida 2) yoqing; izoh 1: `@ali` ; izoh 2: `@ali @vali @ali` | 1-izoh "Mos emas" (sabab: kamida 2 ta farqli do'st); 2-izoh "Qabul qilindi" (belgilanganlar: @ali, @vali — bir xil @ali bitta sanaladi); qoidalar yonida "Qisman" nishoni va tushuntirish ko'rinadi |
| E5 | "Obuna bo'lish" + "Menga ko'rsating" yoqilgan; Instagram obunani tasdiqlay olmaydigan odam izoh yozadi | Holat "Tekshirilmoqda", obuna natijasi "Tasdiqlab bo'lmadi"; qatorda "Qabul qilish / Rad etish"; yuqorida "Tekshirib bo'lmaydiganlarni qabul qilish" bitta bosishda hammasini qabul qiladi ("N ta qabul qilindi") |
| E6 | "Yopish va commit" (inline tasdiq) | Holat Yopilgan; commitment hash ko'rinadi va "Hashni nusxalash" ishlaydi; tushuntirish: qur'adan keyin sha256(seed) shu hashga teng bo'ladi; hali g'olib va seed ko'rinmaydi; yangi izoh endi qabul qilinmaydi |
| E7 | "Qur'a tashlash" → "Tekshirish" → `…/verify` ga mustaqil POST (`seedHex`, `commitment`, `entrants`, `winners`) | G'oliblar va zaxira ro'yxati, bir qatorli tekshirish satri; "Tekshirish" — "Tekshiruv o'tdi"; mustaqil POST ham `ok: true`; commitment = sha256(ochilgan seed); g'oliblar ro'yxatini o'zgartirib yuborsangiz `ok: false` + sabab; seed'ning shifrlangan nusxasi hech bir javobda yo'q |
| E8 | G'olibni "Chetlatish…" (sabab yozing) | Joriy qur'a "Bekor qilingan" (tarixda ko'rinadi, sabab bilan), yangi qur'a YANGI commitment bilan tashlanadi va "Tasdiq kutilmoqda"; eski qur'aning seed'i ochiq qoladi va u ham "Tekshirish" dan o'tadi; sababsiz chetlatish tugmasi ishlamaydi |
| E9 | Qur'ani "Tasdiqlash", so'ng "G'oliblarga xabar": bir g'olib oyna ochiq, ikkinchisi yopiq | Tasdiqlamaguncha xabar tugmasi yo'q va hech narsa ketmaydi; ochiq oynadagiga Direct, yopiq oynadagiga izoh ostida bitta ochiq javob ("@user tabriklaymiz! Direct'ga yozing"), Telegram'ga har doim ro'yxat; har g'olib ostida kanal natijasi va sababi; qayta bosish ikkinchi xabar yubormaydi |
| E10 | Referral tabi: dasturni yoqing (birinchi xabar, ball 10, Telegram), kontaktga kod yarating, havolani do'st ochib birinchi xabarini yozadi; keyin kontaktning o'z havolasi bilan o'zi yozadi; Gamification tabida ballarni ko'ring | Do'st birinchi xabarida taklif "Mukofotlandi": teg + ball + Telegram; o'zini o'zi taklif "Shubhali (o'zini taklif qildi)" bo'lib tasdiqingizni kutadi (Tasdiqlash / Rad etish); ball jurnalida bitta yozuv — qayta ishlansa ikkilanmaydi; yetarli ballda nishon beriladi; reytingda kontakt ko'rinadi; izoh uchun ball sukut bo'yicha o'chiq |

Eslatmalar:
- Havola (`ig.me/m/<username>?ref=rf_<kod>`) yangi suhbatni faqat Icebreakers sozlangan bo'lsa va telefon ilovasida ochadi, Instagram Web'da ishlamaydi — dastur yoqilganda sahifada shu haqida ogohlantirish chiqadi.
- "Qoidalar (Meta)" tabida platforma cheklovlari (yoqtirish/saqlash/ulashish tekshirilmaydi, obuna "imkon qadar", 5 000 izoh chegarasi, bir izohga bitta DM) ro'yxati bor.
- Rollar: Ko'ruvchi va Operator hamma narsani ko'radi, lekin yozish va qur'a tugmalari 403 beradi; CSV eksport faqat Menejer+ (`export_data`).

## ETAP 11 — ManyChat migration (`/developer/migration`)

Yordamli migratsiya: teglar, maydonlar, bot maydonlari va flow ro'yxati API orqali o'qiladi; flow ichini
foydalanuvchi matn/ekran rasmi bilan beradi, AI qoralama flow tuzadi. `MIGRATION_DISABLED=1` — favqulodda
o'chirish (ulash, tahlil, import, aylantirish 503; o'qish va loyihani o'chirish ishlayveradi). Sinov uchun
ManyChat sahifasi (kamida 2 teg, 1 maxsus maydon, 1 bot maydoni, 2 flow), uning API kaliti va ulangan
Instagram akkaunt kerak.

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| M1 | "Ulash" bosqichi: avval noto'g'ri kalit, so'ng to'g'ri kalit bilan "Ulash va tekshirish" | Noto'g'ri kalitda Uzbekcha xato + yechim ("Settings → API dan qayta nusxalang"); sahifa/javob/log'da kalit ko'rinmaydi. To'g'ri kalitda "Tahlil" bosqichiga o'tadi (URL: `?project=…&step=1`), kalit maydoni tozalanadi, faqat oxirgi belgilar (`apiKeyHint`) ko'rinadi; bosqichda "nima o'qiladi / nima mumkin emas" qutisi bor |
| M2 | "Tahlil" → "Tahlilni boshlash", so'ng "Moslashtirish": teg slug'ini tahrirlang ("Saqlanmagan" belgisi), "Teglar va maydonlarni import qilish…" → tasdiq | Hisoblagichlar (teg/maydon/bot maydon/flow/growth tool) ManyChat'dagi bilan teng; jadvallarda nom/papka/holat; import natijasi hisoblari ko'rinadi; CRM teglarida yangi teglar paydo bo'ladi, mavjudlari "birlashtirish" bilan qayta yaratilmaydi; qayta import ikkilantirmaydi |
| M3 | Bot maydonlari jadvalida qiymatni o'zgartirib saqlang va import qiling | Bot maydonlari Flows'dagi o'zgaruvchilar ro'yxatida (qiymatlari bilan) ko'rinadi; mavjud o'zgaruvchi ustiga yozilmaydi (hisobotda "o'tkazib yuborildi") |
| M4 | "Flow'lar" → flow'ni oching, haqiqiy ManyChat flow matnini joylang (trigger so'zi, xabarlar, tugmalar, shart, kutish), maqsad akkaunt va trigger turini tanlang, "AI bilan aylantirish" | Matn yozilganda ~1 s ichida "Aniqlangan imkoniyatlar" (trigger, bloklar) yangilanadi; belgilar hisoblagichi 12000 dan oshsa xato; natijada bloklar ro'yxati, audit (xato/ogohlantirish/taklif), policy PASS/WARNING/BLOCKED va "Qo'lda bajariladiganlar" ko'rinadi; hali flow yaratilmagan |
| M5 | Matnga ManyChat'ning qo'llab-quvvatlanmaydigan elementlarini yozing (WhatsApp/Messenger kanali, to'lov, tashqi so'rov, sequence) | "Aniqlangan imkoniyatlar"da qizil (UNSUPPORTED) / sariq (PARTIAL) qatorlar yechim taklifi bilan; aylantirish natijasida ham "Qo'lda bajariladiganlar"da ro'yxatlanadi; hech biri jimgina yo'qolmaydi |
| M6 | Flow'ni oching, 7 ta rasm tanlang; so'ng 5 MB li rasm; so'ng 2 ta oddiy ekran rasmi bilan saqlang | 7-rasmda "ko'pi bilan 6 ta" xato, katta rasm brauzerda yechim bilan rad etiladi; kichik rasmlar miniatura bilan chiqadi va olib tashlanadi (×); saqlangach rasmlar ro'yxati tozalanadi, matn maydoniga ajratib olingan matn tushadi; ma'lumotlar bazasida (MigrationItem) faqat matn bor, rasm yo'q |
| M7 | Natija ko'rinishida "Qoralama sifatida saqlash" → "Flows'da ochish" | Flow DRAFT (manba: AI), nashr qilinmagan; havola `/developer/flows?flow=<id>` ochiladi, audit va policy natijasi Flows'dagi bilan bir xil; qatorning holati "Import qilingan"; sandbox'da sinab, so'ng nashr qilish mumkin (AI versiya tasdiq talab qiladi); "O'tkazib yuborish" (inline tasdiq) qatorni "O'tkazib yuborilgan" qiladi |
| M8 | "Yakun" bosqichi, so'ng "Loyihani o'chirish" → tasdiq | Yakunda: nima bajarilgani sanoqlari, kontaktlarni qayta opt-in qildirish yo'riqnomasi (ig.me havolasi + `ref`, komment/story trigger), growth tool'larni qayta yaratish, sandbox'da sinash, nashr qilish; Flows/Comments/Triggers havolalari. O'chirgach loyiha ro'yxatda yo'q, `apiKeyEncrypted` tozalangan (DB'da qator yo'q), import qilingan teglar va flow qoralamalari qoladi; `MIGRATION_DISABLED=1` da ham o'chirish ishlaydi |

Eslatmalar:
- Rollar: Ko'ruvchi va Operator loyihalarni ko'radi, lekin ulash/tahlil/import/aylantirish 403 (Menejer+ kerak); sahifada sariq ogohlantirish chiqadi.
- ManyChat API flow ichini, kalit so'z qoidalarini va obunachilarni bermaydi — shuning uchun ular qo'lda (matn bilan) yoki qayta opt-in orqali.
- Kalit hech qachon javobda, logda yoki sahifada qaytmaydi; `__tests__/migration-api.test.ts` buni tekshiradi.

## ETAP 12 — MCP / AI boshqaruv (`/developer/mcp`)

Claude / ChatGPT kabi MCP mijozi orqali SocialAuto'ni o'qish va (tasdiq bilan) o'zgartirish. Endpoint:
`POST /api/mcp` (Bearer token). `MCP_DISABLED=1` — favqulodda o'chirish (`/api/mcp` 503; tokenlarni
ko'rish va bekor qilish ishlayveradi, yangisini yaratib bo'lmaydi). Sinov uchun egasi/administrator
akkaunti, ulangan Instagram akkaunt, kamida 1 kampaniya va 1 kontakt kerak. Tenant tekshiruvi uchun
ikkinchi workspace ham kerak (P8).

| # | Ssenariy | Kutilgan natija |
|---|---|---|
| P0 | "Ulanish" tabidagi manzilni (`https://socialauto.uz/api/mcp`) Claude.ai → Settings → Connectors → "Add custom connector" ga qo'ying → Connect | Brauzerda `socialauto.uz/developer/login?next=…` (developer login), so'ng `/developer/mcp/authorize` ruxsat sahifasi: client nomi ("Claude"), workspace nomi, READ/WRITE tanlovi, "men tasdiqlayman" belgisi. "Ruxsat berish" → Claude'ga qaytadi, ulanish "Connected", asboblar ro'yxati ko'rinadi. "Ulanish" tabida "Ulangan AI mijozlar" ro'yxatida "Claude (OAuth)", "Tokenlar"da OAUTH belgisi bilan. Oddiy login (magic link) bo'lmasa avval `/login?callbackUrl=…` ga yuboradi va qaytib keladi |
| P0a | Xuddi shu manzil bilan Claude Code: `claude mcp add --transport http socialauto https://socialauto.uz/api/mcp`, so'ng `/mcp` → socialauto → Authenticate; ChatGPT: Settings → Connectors → Developer mode → Create → URL, Auth: OAuth | Har ikkisida brauzerda P0 dagi ruxsat sahifasi; ulanish o'rnatiladi. Member/Viewer rolida "Ruxsat berish" tugmasi o'chiq va sabab yozilgan |
| P0b | Ruxsat sahifasida "Rad etish"; keyin ulangan tokenni "Tokenlar"da bekor qiling | Mijoz "access_denied" oladi, token yaratilmaydi. Bekor qilingandan keyin Claude so'rovlari 401 ("Token bekor qilingan") va o'zini yangilay olmaydi — qayta ulash kerak. `curl https://socialauto.uz/.well-known/oauth-authorization-server` endpointlarni ko'rsatadi; `curl -i -X POST https://socialauto.uz/api/mcp` 401 va `WWW-Authenticate: Bearer … resource_metadata="…"` |
| P1 | "Tokenlar" tabida nom + WRITE + muddat 30 kun → "Token yaratish" | `sa_mcp_…` token faqat bir marta ko'rinadi (nusxalash tugmasi, Claude Code `claude mcp add --transport http socialauto <URL> --header "Authorization: Bearer …"`, Claude Desktop va ChatGPT uchun ko'rsatma). "Nusxaladim" bosilgach yoki sahifa yangilangach token qayta ko'rinmaydi; ro'yxatda faqat oxirgi 4 belgi, oxirgi ishlatilgan "hech qachon", holat "Faol". Viewer/Member rolida yaratish va bekor qilish 403, ro'yxat ochiq |
| P2 | "Sinab ko'rish" tabi: token avtomatik tushadi → "tools/list chaqirish" (yoki terminalda `curl -X POST <URL> -H "Authorization: Bearer …" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`) | Asboblar ro'yxati (READ token'da faqat o'qish asboblari, WRITE token'da yozish + `confirm_action` / `reject_action`). `list_campaigns`/`get_campaign`/`list_leads`… bor, "flow nashr qilish" asbobi yo'q. Tokensiz so'rov 401, `GET /api/mcp` 405 |
| P3 | Claude Desktop/Code'ni ulang va so'rang: "kampaniyalarim ro'yxatini ko'rsat", "oxirgi 7 kun statistikasi", "lidlar (stage=NEW, 5 ta)", "diagnostika" | Javoblar workspace'ingiz ma'lumotlari bilan mos; lid kartasida faqat ism, username, bosqich, teglar, oxirgi xabar vaqti — telefon va e-mail yo'q; `get_kpi` da butun platforma navbatlari yo'q. Jurnalda (Amallar tabi) o'qish chaqiruvlari ko'rinmaydi (faqat yozish takliflari) |
| P4 | Yozish: "«narx» so'zi uchun komment kampaniyasi yarat: komment ostiga «Direct'ga yubordik», DM'da narx" | AI avval PREVIEW qaytaradi (kalit so'z, matnlar, "to'xtatilgan holatda"), hech narsa yaratilmagan (Kommentlar ekranida yo'q). Jurnalda holat "Tasdiq kutilmoqda". Siz roziligingizdan keyin AI `confirm_action` chaqiradi → kampaniya PAUSED holatda paydo bo'ladi, jurnal "Bajarildi" + natija; "yoq" desangiz (publish) faqat Instagram ulanishi sog'lom bo'lsa yoqiladi, aks holda qoralama qoladi va sababi yoziladi |
| P5 | Xuddi shu `confirm_action` ni ikkinchi marta chaqiring (yoki ikkita mijozdan bir vaqtda) | Faqat bitta marta bajariladi; ikkinchisi "allaqachon bajarilgan" xatosi; kampaniya bitta |
| P6 | Noto'g'ri kod bilan `confirm_action`; keyin 10 daqiqadan ortiq kuting va to'g'ri kod bilan urining; yana: `reject_action` qilingan amalni tasdiqlang | Noto'g'ri kod: "Tasdiqlash kodi noto'g'ri" (amal saqlanadi, to'g'ri kod bilan hali ishlaydi). 10 daqiqadan keyin: "Amal muddati tugagan", jurnalda "Muddati tugadi". Rad etilgan amal tasdiqlanmaydi. Boshqa token (hatto shu workspace'dagi) boshqa tokenning `actionId`'sini tasdiqlay olmaydi ("topilmadi") |
| P7 | Tokenni "Bekor qilish" (inline tasdiq) → shu token bilan `tools/list` | 401 "Token bekor qilingan"; tasdiq kutayotgan takliflari "Rad etildi" bo'ladi. Muddati tugagan token ham 401 ("muddati tugagan"). Bir daqiqada 60 tadan ko'p so'rov 429 (+ `Retry-After`) |
| P8 | Ikkinchi workspace'da kampaniya/lid/flow yarating; birinchi workspace tokeni bilan ularning id'larini `get_campaign`, `get_flow`, `pause_campaign`, `add_lead_tag`, `set_lead_stage` ga bering; ikkinchi workspace'ning `actionId`'sini `confirm_action` ga bering | Hammasi "topilmadi" (mavjud bo'lmagan id bilan bir xil xabar); ikkinchi workspace'da hech narsa o'zgarmaydi; ro'yxatlarda faqat o'z workspace'ingiz. Boshqa workspace'ning Instagram akkaunti bilan `create_keyword_campaign` / `create_flow_draft` rad etiladi |
| P9 | "Narx so'rab, telefon oladigan flow qoralamasini yarat" (`create_flow_draft`) | PREVIEW'da graf xulosasi (trigger, bloklar soni, xabar matnlari) + audit/policy topilmalari; tasdiqdan keyin Flows ekranida DRAFT (manba: AI), nashr qilinmagan. Nashr qilish uchun Flows'da sandbox testi va tasdiq kerak — MCP orqali nashr qilib bo'lmaydi |
| P10 | Serverda `MCP_DISABLED=1`, web'ni qayta ishga tushiring | `/api/mcp` 503, sahifada qizil ogohlantirish, "Token yaratish" ishlamaydi (503), tokenlarni ko'rish va bekor qilish ishlaydi. Bayroqni olib tashlagach hammasi qaytadi |

Eslatmalar:
- Claude.ai, Claude Desktop va ChatGPT connector'lari sarlavha (Bearer) qabul qilmaydi: ular P0 dagi OAuth yo'li bilan ulanadi. Qo'lda token faqat skriptlar va OAuth'siz mijozlar uchun. OAuth avtomatik testi: `__tests__/mcp-oauth.test.ts`.
- Tokenning o'zi hech qachon bazada, javobda yoki logda yo'q: saqlanadigan narsa sha256 va oxirgi 4 belgi. `__tests__/mcp-confirmation.test.ts` buni tekshiradi.
- Jurnal (`McpAction`) bir vaqtda audit: asbob, taklif, natija/xato, vaqtlar. Bajarilgan va muvaffaqiyatsiz amallar `OperationalEvent` (SYSTEM) ga ham yoziladi.
