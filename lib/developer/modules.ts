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
    href: "/developer/comments",
  },
  {
    key: "triggers",
    etap: 3,
    title: "Instagram Triggers",
    summary:
      "Direct, reklama xabari, ig.me havola, Story Mention / Reply va Live kommentlar — bitta ro'yxatda. Story Reaction kuzatuv rejimida.",
    status: "TESTING",
    href: "/developer/triggers",
  },
  {
    key: "javobai",
    etap: 4,
    title: "JavobAI",
    summary:
      "Knowledge base, AI sales agent, ko'p tillilik, suhbat xotirasi, lead scoring, operatorga topshirish.",
    status: "PLANNED",
  },
  {
    key: "crm",
    etap: 5,
    title: "CRM / Lead Management",
    summary: "Kontaktlar, taglar, segmentlar, pipeline, operator biriktirish, broadcast.",
    status: "PLANNED",
  },
  {
    key: "flow-builder",
    etap: 6,
    title: "Flow Builder",
    summary: "Vizual builder: shartlar, harakatlar, delay, tarmoqlar, Simple va Advanced Mode.",
    status: "PLANNED",
  },
  {
    key: "ai-flow-builder",
    etap: 7,
    title: "AI Flow Builder",
    summary: "Matndan flow yaratish, preview, AI audit, policy va spam tekshiruvi.",
    status: "PLANNED",
  },
  {
    key: "integrations",
    etap: 8,
    title: "Integrations",
    summary: "Telegram, Google Sheets, Webhook, amoCRM, Bitrix24, Make, Zapier.",
    status: "PLANNED",
  },
  {
    key: "engagement",
    etap: 9,
    title: "Engagement",
    summary: "Giveaway, referral, gamification.",
    status: "PLANNED",
  },
  {
    key: "content-analytics",
    etap: 10,
    title: "Content + Analytics",
    summary: "Post/Reels scheduler, kontent kalendar, kampaniya, AI va sotuv analitikasi, funnel.",
    status: "PLANNED",
  },
  {
    key: "migration",
    etap: 11,
    title: "ManyChat Migration",
    summary: "ManyChat flow, trigger va taglarini import qilish.",
    status: "PLANNED",
  },
  {
    key: "mcp",
    etap: 12,
    title: "MCP / AI Control",
    summary: "Claude / ChatGPT orqali SocialAuto'ni boshqarish (tasdiqlash bilan).",
    status: "PLANNED",
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
