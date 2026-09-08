# IGDM — panel va landing (front-end)

Instagram izoh → direkt avtomatizatsiya platformasining to'liq interfeysi.
Backend: `igdm-backend` (FastAPI + ARQ + PostgreSQL + Redis).

## Ishga tushirish

```bash
npm install
npm run dev          # http://localhost:3000
```

Backendga ulash uchun `.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Hozir sahifalar `lib/mock.ts` dagi namunaviy ma'lumot bilan ishlaydi.
Real ma'lumotga o'tish uchun sahifadagi `mock` importini `lib/api.ts`
funksiyalariga almashtiring — javob shakllari `app/schemas/*.py` bilan bir xil.

## Sahifalar

| Yo'l | Nima |
|---|---|
| `/` | Landing — besh parda (arrival → descent → pin → swarm → landing) |
| `/login` | Panelga kirish |
| `/dashboard` | Bugungi holat, oxirgi izohlar, ulanish sog'ligi |
| `/campaigns` | Kampaniyalar ro'yxati, ustuvorlik, yoqish/o'chirish |
| `/campaigns/[id]` | Kampaniya muharriri + jonli chat preview + test rejimi |
| `/logs` | Jurnal: filtr, qidiruv, xato kodlarining tushuntirilishi |
| `/leads` | Lidlar va CSV eksport |
| `/accounts` | Instagram ulanishi, token, webhook obunasi |
| `/settings` | Vaqt mintaqasi, til, ogohlantirishlar, chegaralar |

## Dizayn tizimi — "ABRBAND"

Barcha token `app/globals.css` da. Komponentlarda xom hex yo'q.

| Token | Qiymat | Roli |
|---|---|---|
| `--c-field` | `#1a1b72` | 60% — ikat indigosi, asosiy maydon |
| `--c-madder` | `#e23d2c` | 30% — marena qizili, indigo bilan urishadi |
| `--c-saffron` | `#ffb01f` | urushni hal qiluvchi rang: struktura, marginaliya |
| `--c-signal` | `#00f0b5` | 10% — faqat fokus nuqta va CTA |
| `--c-paper` | `#f3ead9` | ish stoli yuzasi (zich ma'lumot shu yerda o'qiladi) |
| `--c-wrong` | `#0a84ff` | "noto'g'ri" rang, sahifada bir marta: jonli webhook puls |

Shrift: **Unbounded** (display) · **Manrope** (matn) · **JetBrains Mono**
(yorliq, raqam, marginaliya). Uchalasi ham lotin + kirill.
Shkala nisbati 1.333.

## Motion

Barcha xoreografiya `components/motion/useActs.ts` da; komponentlar gsap'ni
o'zi chaqirmaydi. Faqat `transform` va `opacity` animatsiya qilinadi —
yagona istisno: ACT 3 dagi kabelning `stroke-dashoffset` chizilishi
(layout emas, faqat paint). Sahifada **bitta** pin bor (ACT 3).
`prefers-reduced-motion` da hamma narsa yakuniy holatda turadi,
mobilda pin butunlay o'chadi va qatlamlar 2 taga tushadi.

3D qatlam WebGL emas, CSS 3D (`perspective`, `preserve-3d`, ko'p qatlamli
soya). Sabab: auditoriya Toshkentda mobil internetdan, o'rta darajadagi
Android bilan kiradi — env-map bilan WebGL 1.5–3 MB va birinchi ekran
konversiyani yeydi.

---

## Dizayn eslatmasi

**Signature.** "Kommutator" — ACT 3 dagi yagona pinlangan bo'lim: eski
telefon kommutatori, unda skroll bitta patch-kabelni izoh jakidan shart
jakiga, undan havola jakiga sudraydi; uchta chiroq backend ishga tushirgan
tartibda yonadi, kabel ulangan zahoti 24 soatlik javob oynasi sanay
boshlaydi. Bu bezak emas — bu funnelning o'zi, mashina sifatida chizilgan.

**Risk.** Palitra qo'lda bo'yalgan ikat (abrband) dan olingan: indigo va
marena qizili haqiqatan urishadi, ularni safron ushlab turadi; bo'limlar
orasidagi chegara to'g'ri chiziq emas, "abr" — taroqsimon oqish. Bu risk
shu brief uchun to'g'ri, chunki mahsulot Toshkentdagi kichik biznesga
sotiladi va u global SaaS shablonidan farq qilishi kerak; o'qish esa
himoyalangan — matn har doim qattiq yuzada (`--c-paper` yoki solid plate),
hech qachon gradient ustida turmaydi.

**Nimani kesib tashladim (Chanel qoidasi).** Landing sahifada boshida
kampaniya natijalarini ko'rsatadigan jonli "statistika lentasi" bor edi —
u pinlangan kommutator bilan bir ekranda ikkita fokus yaratardi.
Olib tashlandi. Keyingi kesish: ACT 2 dagi `01:14` katta raqami — u
kuchli, lekin agar mobil FPS pasaysa, birinchi bo'lib u ketadi.
