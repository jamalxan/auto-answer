# Ko'p tarmoqli kontent reja — 1-bosqich (poydevor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/content` da tarmoq tanlagichi (Hammasi · Instagram · Facebook · Threads · YouTube), faqat-Instagramsiz postlar va kompozerda "Hammasiga birga / Har biriga alohida" rejimlari.

**Architecture:** `ScheduledPost.instagramAccountId` nullable bo'ladi; null bo'lsa IG navbati (prepare/publish joblar, quota, slot) o'tkazib yuboriladi va post holati `ChannelPostTarget`lar natijasidan hisoblanadi (yangi sweep qadami). "Alohida" rejim `ChannelPostTarget.captionOverride` / `scheduledAtOverride` orqali. Tarmoq filtri `GET /api/content/posts?network=` va UI tanlagichi.

**Tech Stack:** Next.js (AGENTS.md: `node_modules/next/dist/docs/` ni o'qing), Prisma + Postgres, BullMQ, vitest, Tailwind brend primitivlari.

**Spec:** `docs/superpowers/specs/2026-10-29-multi-network-content-design.md`

## Global Constraints

- Matnlar o'zbekcha (lotin), mavjud uslubda.
- Instagram oqimi (IG akkauntli postlar) xatti-harakati o'zgarmasin: `__tests__/content-*.test.ts` va `channels-*.test.ts` yashil qolishi shart.
- Telegram cross-post (`channel: "telegram"`) ishlashda davom etadi.
- Har task oxirida `npm run typecheck` va tegishli vitest yashil; Prisma o'zgarsa `npx prisma generate` keyin dev serverni qayta ishga tushirish (local-dev-env eslatmasi).
- Migratsiya nomi `prisma/migrations/20261109100000_multi_network_posts`.
- Ishlash tarmog'i: yangi branch `feat/content-multi-network` (joriy `feat/content-multi-platform` dan).

## Review Focus

1. IG'siz post `DRAFT` da qoladi va hech qanday target yo'q → rejalashtirishda aniq xato ("kamida bitta tarmoq tanlang"), jim muvaffaqiyat emas.
2. IG'siz postda barcha targetlar `FAILED` → post `FAILED` (retry tugmasi ishlaydi), `PUBLISHED` emas.
3. Targetlarning bir qismi chiqdi, bir qismi xato → post `PUBLISHED`, xato target kartochkada ko'rinadi.
4. IG akkaunt o'chirilsa (`onDelete: Cascade`) IG'siz postlarga ta'sir qilmasligi; IG'li postlar avvalgidek o'chadi.
5. `override` vaqti postning vaqtidan oldin bo'lsa yoki 5 daqiqadan yaqin bo'lsa rad etiladi.

---

### Task 1: Schema + migratsiya

**Files:**
- Modify: `prisma/schema.prisma` (`ScheduledPost`, `ChannelPostTarget`, `InstagramAccount` relatsiyasi)
- Create: `prisma/migrations/20261109100000_multi_network_posts/migration.sql`

**Interfaces:**
- Produces: `ScheduledPost.instagramAccountId: string | null`, `ScheduledPost.instagramAccount: InstagramAccount | null`; `ChannelPostTarget.captionOverride: string | null`, `ChannelPostTarget.scheduledAtOverride: Date | null`.

- [ ] **Step 1:** `ScheduledPost.instagramAccountId String?` va `instagramAccount InstagramAccount?`; `ChannelPostTarget` ga `captionOverride String?` va `scheduledAtOverride DateTime?`. SQL: `ALTER COLUMN "instagramAccountId" DROP NOT NULL` + ikkita `ADD COLUMN`.
- [ ] **Step 2:** `npx prisma generate`; `npm run typecheck` — chiqqan xatolar ro'yxatini yozib oling (keyingi tasklar shularni tuzatadi).
- [ ] **Step 3:** Commit `feat(content): nullable Instagram account on posts, per-target caption/time overrides`.

### Task 2: Servis qatlami — IG'siz post yaratish va rejalashtirish

**Files:**
- Modify: `lib/content/schema.ts` (`postInputSchema.instagramAccountId` → `.min(1).nullable().optional()`; `postsQuerySchema` ga `network: z.enum(["instagram","facebook","threads","youtube"]).optional()`)
- Modify: `lib/content/service.ts` (`createPost`, `updatePost`, `schedulePost`, `rearmIfNeeded`, `duplicatePost`, `listPosts`, `PostCard`/`PostDetail` turlari)
- Modify: `lib/content/publish.ts`, `lib/content/quota.ts`, `lib/content/slots.ts`, `lib/content/link-campaign.ts`, `lib/content/notify.ts` — Task 1 typecheck xatolari bo'yicha (IG kerak bo'lgan joyda `if (!post.instagramAccountId) return/throw ContentError(409, "Bu post Instagram'ga bog'liq emas")`).
- Test: `__tests__/content-multi-network.test.ts`

**Interfaces:**
- Consumes: Task 1 turlari.
- Produces: `createPost` null IG bilan ishlaydi; `schedulePost` null IG da `spacedSlot`/`accountQuota`/`armJobs` ni chaqirmaydi, statusni `SCHEDULED` qiladi va `scheduledAt = at` ni saqlaydi, hech bo'lmasa bitta `ChannelPostTarget` yo'q bo'lsa `ContentError(400, "Kamida bitta tarmoq tanlang")`; `listPosts` `network` filtri: `instagram` → `instagramAccountId != null`, boshqalari → `channelTargets.some({ channel })`; `PostCard.networks: string[]` (targetlardagi kanallar + `instagram` agar IG bor).

- [ ] **Step 1:** Testlar (`content-multi-network.test.ts`, mavjud testlarning mock uslubida): `createPost` null IG → DRAFT; `schedulePost` target yo'q → 400 xabar "Kamida bitta tarmoq tanlang"; target bor → `SCHEDULED` va `schedulePrepare/schedulePublish` chaqirilmadi; `listPosts({network:"facebook"})` faqat facebook targetli postni qaytaradi.
- [ ] **Step 2:** Testlar FAIL ekanini tekshiring: `npx vitest run __tests__/content-multi-network.test.ts`.
- [ ] **Step 3:** Yuqoridagi fayllarni o'zgartiring; `npm run typecheck` 0 xato.
- [ ] **Step 4:** `npx vitest run __tests__/content-` — hammasi PASS.
- [ ] **Step 5:** Commit `feat(content): posts without an Instagram account (network-only posts)`.

### Task 3: Worker — IG'siz postlarni chiqarish va holatini hisoblash

**Files:**
- Modify: `lib/content/sweep.ts` (1+2 qadam `where` ga `instagramAccountId: { not: null }`; yangi 7-qadam `settleNetworkOnlyPosts`), `lib/channels/crosspost.ts` (`sweepCrossPosts` override vaqt/matn; `buildVariant` `captionOverride`)
- Test: `__tests__/channels-crosspost-network-only.test.ts`

**Interfaces:**
- Produces: `settleNetworkOnlyPosts(now: Date): Promise<number>` — `instagramAccountId: null`, `status: "SCHEDULED"` postlar uchun: barcha targetlar `PUBLISHED|FAILED|SKIPPED|DELETED` bo'lsa → kamida bittasi `PUBLISHED` bo'lsa post `PUBLISHED` (`publishedAt = now`), aks holda `FAILED` (`lastErrorCode: "NETWORK_ALL_FAILED"`, `lastErrorMessage` = birinchi target xatosi). `SweepResult.networkSettled?: number`.
- Cross sweep: target uchun ish vaqti `target.scheduledAtOverride ?? post.scheduledAt`; matn `captionOverride ?? post.caption` (`buildVariant` ichida `target.captionOverride` ni olish uchun `idempotencyKey = target.id` bo'yicha target topiladi yoki `buildVariant` ga `captionOverride?: string | null` parametri qo'shiladi).

- [ ] **Step 1:** Testlar: (a) IG'siz SCHEDULED post, barcha target PUBLISHED → post PUBLISHED; (b) hammasi FAILED → FAILED/`NETWORK_ALL_FAILED`; (c) bittasi PENDING → o'zgarmaydi; (d) `scheduledAtOverride` kelajakda bo'lsa target chiqarilmaydi, o'tgan bo'lsa chiqariladi; (e) `captionOverride` variantga tushadi.
- [ ] **Step 2:** FAIL tekshiruvi → implement → PASS (`npx vitest run __tests__/channels- __tests__/content-sweep.test.ts`).
- [ ] **Step 3:** Commit `feat(content): publish and settle network-only posts in the sweeper`.

### Task 4: Targets API — override maydonlari

**Files:**
- Modify: `app/api/channels/targets/route.ts`, `lib/channels/crosspost.ts` (`setChannelTargets`, `setTelegramTargets` imzosi: `credentialIds: string[] | Array<{ id: string; caption?: string | null; scheduledAt?: string | null }>`)
- Test: `__tests__/channels-targets-override.test.ts`

**Interfaces:**
- Produces: `POST /api/channels/targets` body `{ postId, channel, accountIds: string[] , overrides?: Record<string, { caption?: string|null; scheduledAt?: string|null }> }`; override `scheduledAt` post vaqtidan oldin yoki `now + 5 min` dan erta bo'lsa `CrossPostError(400, "Vaqt noto'g'ri")`. `GET` targetlarda `captionOverride`, `scheduledAtOverride` qaytadi.

- [ ] **Step 1:** Testlar (Review Focus 5 shu yerda): to'g'ri override saqlanadi; erta vaqt 400; override bo'lmasa null.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Commit `feat(channels): per-target caption and time overrides`.

### Task 5: UI — tarmoq tanlagichi va filtr

**Files:**
- Create: `components/content/network-switcher.tsx`
- Modify: `components/content/content-dashboard.tsx` (URL param `?net=`, `navigate` ga `net`), `components/content/timeline-view.tsx`, `components/content/calendar-view.tsx` (so'rovga `network`), `components/content/shared.ts` (`ContentMeta.networks: Array<{ key: NetworkKey; label: string; accounts: number }>`, `NetworkKey`), `app/api/content/meta/route.ts` (akkaunt sonlari: IG `instagramAccount` + `channelCredential` har kanal bo'yicha ACTIVE/EXPIRING)
- Test: `__tests__/content-network-switcher.test.ts` (mantiq: `networkFromParam`, hisoblash)

**Interfaces:**
- Produces: `export type NetworkKey = "all" | "instagram" | "facebook" | "threads" | "youtube"`; `export function networkFromParam(value: string | null): NetworkKey` (noma'lum → `"all"`); `<NetworkSwitcher value={NetworkKey} networks={ContentMeta["networks"]} onChange={(n) => void} />` — chip qatori, har chipda tarmoq belgisi (`ChannelMark` dan) va akkaunt soni.

- [ ] **Step 1:** Test: `networkFromParam("facebook") === "facebook"`, `networkFromParam("x") === "all"`, `null` → `"all"`.
- [ ] **Step 2:** FAIL → implement (`NetworkSwitcher`, URL ulash, meta, timeline/calendar so'rovlari) → PASS; `npm run typecheck`.
- [ ] **Step 3:** Brauzerda tekshiring (local-dev-env: dev server `NEXTAUTH_URL=http://localhost:3000`): tanlagich ko'rinadi, URL `?net=facebook` ga o'zgaradi, reja filtrlanadi.
- [ ] **Step 4:** Commit `feat(content): network switcher on the content page`.

### Task 6: Kompozer — rejimlar va IG ixtiyoriy

**Files:**
- Modify: `components/content/composer.tsx` (rejim toggle `"together" | "separate"`, IG akkaunt tanlovi ixtiyoriy), `components/content/cross-targets.tsx` (Instagram akkauntlari ham shu ro'yxatda; "alohida" rejimda har tarmoq qatorida matn va vaqt maydoni), `components/content/post-detail.tsx` (targetlar ro'yxati override ko'rsatadi), `lib/content/platform-preview.ts` (Instagramsiz tur tekshiruvi)
- Test: `__tests__/content-composer-modes.test.ts` (sof mantiq: `buildTargetPayload(mode, selection, overrides)`)

**Interfaces:**
- Produces: `buildTargetPayload(mode: "together" | "separate", selection: CrossSelection, overrides: Record<string, { caption?: string; scheduledAt?: string }>): { channel: CrossChannel; accountIds: string[]; overrides: Record<string, {...}> }[]` — "together" da overrides bo'sh; "separate" da bo'sh qiymatlar olib tashlanadi.

- [ ] **Step 1:** Test: together rejimda overrides tushmaydi; separate da bo'sh caption olib tashlanadi, to'ldirilgani qoladi.
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Brauzerda: faqat Facebook tanlab post yarating, rejalashtiring, "Reja"da `FB` belgisi bilan ko'rinishini tekshiring; "alohida" rejimda ikki tarmoqqa har xil matn.
- [ ] **Step 4:** To'liq tekshiruv: `npm run typecheck && npx vitest run && npm run lint`. Commit `feat(content): together/separate modes and network-only posts in the composer`.

### Task 7: Yakun — PR

- [ ] **Step 1:** `git push -u origin feat/content-multi-network`, PR (`gh pr create`), tavsifda bosqich 1 qamrovi va qolgan 4 bosqich ro'yxati.
- [ ] **Step 2:** Deploy foydalanuvchi tasdig'idan keyin (outward-facing): prod migratsiyasi `20261109100000_multi_network_posts` ni ishga tushirish `prisma migrate deploy` bilan, web/worker `--no-deps` restart.
