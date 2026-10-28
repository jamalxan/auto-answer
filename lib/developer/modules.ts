/**
 * The developer area's module registry — the one place that says what is
 * being built, at which stage of the master plan (SocialAuto_Master_TZ,
 * section 63), and where to open it. The /developer nav and overview page
 * both render from this list.
 *
 * A module moves PLANNED → BUILDING → TESTING → READY. READY means it passed
 * its tests and is waiting for the owner's decision to move it into the main
 * product; nothing here is ever linked from the customer UI.
 */

export type ModuleStatus = "PLANNED" | "BUILDING" | "TESTING" | "READY";

export interface DeveloperModule {
  key: string;
  etap: number;
  title: string;
  summary: string;
  status: ModuleStatus;
  /** Only modules with a screen have one. */
  href?: string;
}

export const DEVELOPER_MODULES: DeveloperModule[] = [
  {
    key: "foundation",
    etap: 1,
    title: "Foundation",
    summary:
      "Instagram ulanish holati, qayta ulash, tushunarli xatolar, navbat (queue) va diagnostika.",
    status: "TESTING",
    href: "/developer/foundation",
  },
  {
    key: "comment-automation",
    etap: 2,
    title: "Comment Automation 2.0",
    summary:
      "Kuchli keywordlar, bir nechta javob varianti, AI javoblar, eski kommentlar, quick reply, follow-up.",
    status: "TESTING",
    href: "/comments",
  },
  {
    key: "triggers",
    etap: 3,
    title: "Instagram Triggers",
    summary:
      "Direct, reklama xabari, ig.me havola, Story Mention / Reply va Live kommentlar — bitta ro'yxatda. Story Reaction kuzatuv rejimida.",
    status: "TESTING",
    href: "/triggers",
  },
  {
    key: "javobai",
    etap: 4,
    title: "JavobAI",
    summary:
      "Knowledge base, AI sales agent, ko'p tillilik, suhbat xotirasi, lead scoring, operatorga topshirish.",
    status: "TESTING",
    href: "/javobai",
  },
  {
    key: "crm",
    etap: 5,
    title: "CRM / Lead Management",
    summary: "Kontaktlar, taglar, segmentlar, pipeline, operator biriktirish, broadcast.",
    status: "TESTING",
    href: "/developer/crm",
  },
  {
    key: "flow-builder",
    etap: 6,
    title: "Flow Builder",
    summary: "Vizual builder: shartlar, harakatlar, delay, tarmoqlar, Simple va Advanced Mode.",
    status: "TESTING",
    href: "/developer/flows",
  },
  {
    key: "ai-flow-builder",
    etap: 7,
    title: "AI Flow Builder (Beta)",
    summary: "Matndan flow yaratish, preview, AI audit, policy va spam tekshiruvi. Beta: sekin va ba'zan ishlatib bo'lmaydigan javob — tayyor shablonlar asosiy yo'l.",
    status: "TESTING",
    href: "/developer/flows?tab=ai",
  },
  {
    key: "integrations",
    etap: 8,
    title: "Integrations",
    summary: "Telegram, Google Sheets, Webhook, amoCRM, Bitrix24, Make, Zapier.",
    status: "TESTING",
    href: "/developer/integrations",
  },
  {
    key: "engagement",
    etap: 9,
    title: "Engagement",
    summary: "Giveaway, referral, gamification.",
    status: "TESTING",
    href: "/developer/engagement",
  },
  {
    key: "content-analytics",
    etap: 10,
    title: "Analitika",
    summary: "Kampaniya, AI va sotuv analitikasi, funnel, KPI va ogohlantirishlar.",
    status: "TESTING",
    href: "/developer/analytics",
  },
  {
    key: "migration",
    etap: 11,
    title: "ManyChat Migration",
    summary: "ManyChat flow, trigger va taglarini import qilish.",
    status: "TESTING",
    href: "/developer/migration",
  },
  {
    key: "mcp",
    etap: 12,
    title: "MCP / AI Control",
    summary: "Claude / ChatGPT orqali SocialAuto'ni boshqarish (tasdiqlash bilan).",
    status: "TESTING",
    href: "/developer/mcp",
  },
  {
    key: "content-scheduler",
    etap: 13,
    title: "Content Scheduler",
    summary: "Post, karusel, Reels va Story rejalashtirish; qo'lda e'lon; post → comment-to-DM bog'lanishi.",
    // Promoted 2026-10-26: lives in the main dashboard at /content.
    status: "READY",
    href: "/content",
  },
  {
    key: "telegram-channel",
    etap: 14,
    title: "Telegram kanal",
    summary:
      "Bot kanal admini sifatida: nashr (Content Scheduler'dan kross-post), muhokama kommentlari, kanal DM'lari, Telegram Business.",
    status: "TESTING",
    href: "/developer/telegram",
  },
  {
    key: "content-intel",
    etap: 15,
    title: "Kontent intellekti",
    summary:
      "Post natijasi akkaunt medianasiga nisbatan, comment → DM → lid → sotuv, video tahlil va tipik xatolar, haftalik hisobot, 2 haftalik reja, Reel senariy, Trial Reels hook testi.",
    status: "TESTING",
    href: "/developer/content-intel",
  },
  {
    key: "channel-adapters",
    etap: 16,
    title: "Facebook · Threads · YouTube",
    summary:
      "Kanal adapterlari: OAuth ulash (vault), kommentlar va Messenger inbox, shaxsiy javob (bir marta, 7 kun), Content Scheduler'dan kross-post (Reels, Shorts, kunlik limit va kvota).",
    status: "TESTING",
    href: "/channels",
  },
  {
    key: "ads",
    etap: 17,
    title: "Reklama",
    summary:
      "Medianadan 2× yaxshi post uchun boost taklifi, egasining tasdig'i bilan ishga tushirish, kunlik / oylik chegara va CPL bo'yicha avto-pauza, Click-to-Direct konteksti AI'ga, CRM sotuvi → Conversions API.",
    status: "TESTING",
    href: "/ads",
  },
  {
    key: "billing",
    etap: 18,
    title: "Tariflar va to'lov",
    summary:
      "Start / Biznes / Pro / Agentlik: kanallar, AI javoblar, avto rejim, rejalashtirilgan post va video tahlil limitlari (BILLING_ENFORCED bilan), Click va Payme to'lovi (flag ortida).",
    status: "TESTING",
    href: "/developer/billing",
  },
];

export const MODULE_STATUS_LABEL: Record<ModuleStatus, string> = {
  PLANNED: "Rejada",
  BUILDING: "Qurilmoqda",
  TESTING: "Test qilinmoqda",
  READY: "Tayyor — tasdiq kutilmoqda",
};

/** Modules that have a screen, in master-plan order, for the nav. */
export function navigableModules(): DeveloperModule[] {
  return DEVELOPER_MODULES.filter((m) => m.href).sort((a, b) => a.etap - b.etap);
}
