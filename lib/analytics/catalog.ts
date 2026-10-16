/**
 * The metric catalog: every key the rollups store, what it is called on the
 * screen and how it is shown. Rollup rows hold sums and counts only; the
 * rates below are derived at read time (a sum of rates is meaningless).
 * Pure, client-safe.
 */

export type AnalyticsTab = "campaign" | "ai" | "sales" | "funnel";
export const ANALYTICS_TABS: AnalyticsTab[] = ["campaign", "ai", "sales", "funnel"];

export type MetricFormat = "int" | "usd" | "ms" | "pct";

export interface MetricDef {
  key: string;
  label: string;
  format: MetricFormat;
  hint?: string;
}

export interface DerivedDef {
  key: string;
  label: string;
  format: MetricFormat;
  /** ratio: num / den as a fraction; avg: num / den in the unit of num. */
  kind: "ratio" | "avg";
  num: string;
  den: string;
  hint?: string;
}

export const DIM_KINDS = ["automation", "trigger_campaign", "broadcast", "reason", "kind", "pipeline", "member"] as const;
export type DimKind = (typeof DIM_KINDS)[number];

export const DIM_LABELS: Record<DimKind, string> = {
  automation: "Comment kampaniya",
  trigger_campaign: "Trigger kampaniya",
  broadcast: "Broadcast",
  reason: "Sabab",
  kind: "AI turi",
  pipeline: "Pipeline",
  member: "Jamoa a'zosi",
};

export function isDimKind(value: unknown): value is DimKind {
  return typeof value === "string" && (DIM_KINDS as readonly string[]).includes(value);
}

// ─── Campaign ────────────────────────────────────────────────────────────────

export const CAMPAIGN_METRICS: MetricDef[] = [
  { key: "campaign.sent", label: "Yuborildi", format: "int", hint: "Comment kampaniya, trigger va broadcast DM'lari" },
  { key: "campaign.followup_sent", label: "Follow-up yuborildi", format: "int" },
  { key: "campaign.delivered", label: "Qabul qilindi (Meta)", format: "int", hint: "v1: Meta yuborishni qabul qilgan xabarlar" },
  { key: "campaign.failed", label: "Xato", format: "int" },
  { key: "campaign.skipped", label: "O'tkazib yuborildi", format: "int" },
  { key: "campaign.replies", label: "Javoblar", format: "int", hint: "Mijoz yozgan suhbatlar (eski trigger'larda: ochilgan)" },
  { key: "campaign.clicks", label: "Bosishlar", format: "int" },
  { key: "campaign.leads", label: "Lidlar", format: "int" },
  { key: "campaign.conversions", label: "Konversiyalar", format: "int" },
];

export const CAMPAIGN_DERIVED: DerivedDef[] = [
  { key: "campaign.ctr", label: "CTR", format: "pct", kind: "ratio", num: "campaign.clicks", den: "campaign.sent" },
  { key: "campaign.reply_rate", label: "Javob darajasi", format: "pct", kind: "ratio", num: "campaign.replies", den: "campaign.sent" },
  { key: "campaign.failure_rate", label: "Xato darajasi", format: "pct", kind: "ratio", num: "campaign.failed", den: "campaign.sent" },
];

// ─── AI ──────────────────────────────────────────────────────────────────────

export const AI_METRICS: MetricDef[] = [
  { key: "ai.conversations", label: "AI suhbatlar", format: "int", hint: "JavobAI (LIVE) boshlagan suhbatlar" },
  { key: "assistant.conversations", label: "Assistent suhbatlari", format: "int", hint: "Production assistent (JavobAI'siz)" },
  { key: "ai.resolved", label: "AI hal qildi", format: "int", hint: "Lid yig'ildi va operator kerak bo'lmadi (qat'iy v1)" },
  { key: "ai.handoff", label: "Operatorga topshirildi", format: "int" },
  { key: "ai.handoff_accepted", label: "Operator qabul qildi", format: "int" },
  { key: "ai.qualified", label: "Sifatli lidlar", format: "int", hint: "WARM yoki HOT" },
  { key: "ai.hot", label: "Hot lidlar", format: "int" },
  { key: "ai.calls", label: "LLM chaqiruvlar", format: "int" },
  { key: "ai.failed_calls", label: "Xato chaqiruvlar", format: "int" },
  { key: "ai.cost_usd", label: "Xarajat", format: "usd" },
  { key: "ai.tokens_in", label: "Kirish tokenlari", format: "int" },
  { key: "ai.tokens_out", label: "Chiqish tokenlari", format: "int" },
  { key: "ai.shadow_turns", label: "Shadow javoblar", format: "int" },
  { key: "ai.blocked_replies", label: "Bloklangan javoblar", format: "int" },
  { key: "ai.fallbacks", label: "Fallback", format: "int" },
  { key: "ai.llm_errors", label: "LLM xatolari", format: "int" },
  { key: "msg.customer", label: "Mijoz xabarlari", format: "int" },
  { key: "msg.ai", label: "AI xabarlari", format: "int" },
  { key: "msg.operator", label: "Operator xabarlari", format: "int" },
];

/** Sum parts kept only for the derived averages; not shown as tiles. */
export const AI_HELPER_METRICS = ["ai.latency_ms_sum", "ai.handoff_wait_ms_sum", "ai.handoff_wait_count"] as const;

export const AI_DERIVED: DerivedDef[] = [
  { key: "ai.success_rate", label: "AI muvaffaqiyat darajasi", format: "pct", kind: "ratio", num: "ai.resolved", den: "ai.conversations" },
  { key: "ai.handoff_rate", label: "Topshirish darajasi", format: "pct", kind: "ratio", num: "ai.handoff", den: "ai.conversations" },
  { key: "ai.qualified_rate", label: "Sifatli lid ulushi", format: "pct", kind: "ratio", num: "ai.qualified", den: "ai.conversations" },
  { key: "ai.avg_latency_ms", label: "O'rtacha kechikish", format: "ms", kind: "avg", num: "ai.latency_ms_sum", den: "ai.calls" },
  { key: "ai.avg_handoff_wait_ms", label: "Operator kutish vaqti", format: "ms", kind: "avg", num: "ai.handoff_wait_ms_sum", den: "ai.handoff_wait_count" },
  { key: "ai.cost_per_conversation", label: "Suhbat narxi", format: "usd", kind: "avg", num: "ai.cost_usd", den: "ai.conversations" },
];

// ─── Sales ───────────────────────────────────────────────────────────────────

export const SALES_METRICS: MetricDef[] = [
  { key: "sales.leads", label: "Lidlar", format: "int" },
  { key: "sales.qualified", label: "Sifatli (bog'lanildi)", format: "int", hint: "Bitim boshlang'ich bosqichdan chiqdi" },
  { key: "sales.won", label: "Sotuv (Won)", format: "int", hint: "Sotuv = pipeline'dagi WON bitim" },
  { key: "sales.lost", label: "Yo'qotilgan", format: "int" },
  { key: "sales.customer_marked", label: "Qo'lda 'Mijoz'", format: "int", hint: "Bitimsiz CUSTOMER deb belgilanganlar (sotuvga qo'shilmaydi)" },
];

export const SALES_HELPER_METRICS = ["sales.score_sum", "sales.score_count", "sales.cycle_ms_sum", "sales.cycle_ms_count"] as const;

export const SALES_DERIVED: DerivedDef[] = [
  { key: "sales.conversion_rate", label: "Konversiya", format: "pct", kind: "ratio", num: "sales.won", den: "sales.leads" },
  { key: "sales.qualified_rate", label: "Sifatli ulushi", format: "pct", kind: "ratio", num: "sales.qualified", den: "sales.leads" },
  { key: "sales.avg_score", label: "O'rtacha lid bali", format: "int", kind: "avg", num: "sales.score_sum", den: "sales.score_count" },
  { key: "sales.avg_cycle_ms", label: "O'rtacha sotuv sikli", format: "ms", kind: "avg", num: "sales.cycle_ms_sum", den: "sales.cycle_ms_count" },
];

// ─── Funnel ──────────────────────────────────────────────────────────────────

export interface FunnelStageDef {
  key: string;
  label: string;
  metric: string;
}

/** Period mode: each stage is a rollup metric, so stages are counts in the same period, not a tracked cohort. */
export const FUNNEL_STAGES: FunnelStageDef[] = [
  { key: "comments", label: "Kommentlar", metric: "funnel.comments" },
  { key: "dms", label: "DM'lar", metric: "funnel.dms" },
  { key: "replies", label: "Javoblar", metric: "campaign.replies" },
  { key: "leads", label: "Lidlar", metric: "sales.leads" },
  { key: "hot", label: "Hot", metric: "ai.hot" },
  { key: "sales", label: "Sotuvlar", metric: "sales.won" },
];

export const FUNNEL_NOTE = "SocialAuto ko'rgan kommentlar (Meta yubormagan kommentlar hisobga olinmaydi)";

// ─── Cohort comparison (AI vs human) ─────────────────────────────────────────

export const COHORT_METRICS = [
  "cohort.ai_only.conversations",
  "cohort.ai_only.leads",
  "cohort.ai_only.won",
  "cohort.handed_off.conversations",
  "cohort.handed_off.leads",
  "cohort.handed_off.won",
] as const;

// ─── Lookup ──────────────────────────────────────────────────────────────────

export function metricsForTab(tab: AnalyticsTab): MetricDef[] {
  if (tab === "campaign") return CAMPAIGN_METRICS;
  if (tab === "ai") return AI_METRICS;
  if (tab === "sales") return SALES_METRICS;
  return [];
}

export function derivedForTab(tab: AnalyticsTab): DerivedDef[] {
  if (tab === "campaign") return CAMPAIGN_DERIVED;
  if (tab === "ai") return AI_DERIVED;
  if (tab === "sales") return SALES_DERIVED;
  return [];
}

/** Every stored key a tab needs, helpers included. */
export function storedKeysForTab(tab: AnalyticsTab): string[] {
  const keys = metricsForTab(tab).map((m) => m.key);
  if (tab === "ai") keys.push(...AI_HELPER_METRICS);
  if (tab === "sales") keys.push(...SALES_HELPER_METRICS);
  if (tab === "funnel") keys.push(...FUNNEL_STAGES.map((s) => s.metric), "sales.customer_marked");
  // Derived inputs that are not tiles of this tab.
  for (const def of derivedForTab(tab)) keys.push(def.num, def.den);
  return [...new Set(keys)];
}

export function defaultDimKinds(tab: AnalyticsTab): DimKind[] {
  if (tab === "campaign") return ["automation", "trigger_campaign", "broadcast"];
  if (tab === "ai") return ["reason", "kind"];
  if (tab === "sales") return ["pipeline", "member"];
  return [];
}

const ALL_DEFS = new Map<string, { label: string; format: MetricFormat; hint?: string }>();
for (const def of [...CAMPAIGN_METRICS, ...AI_METRICS, ...SALES_METRICS, ...CAMPAIGN_DERIVED, ...AI_DERIVED, ...SALES_DERIVED]) {
  ALL_DEFS.set(def.key, def);
}

export function metricDef(key: string): { label: string; format: MetricFormat; hint?: string } | null {
  return ALL_DEFS.get(key) ?? null;
}

/** Derived value from summed inputs; null when the denominator is empty. */
export function deriveValue(def: DerivedDef, values: Record<string, number>): number | null {
  const den = values[def.den] ?? 0;
  if (!den) return null;
  const value = (values[def.num] ?? 0) / den;
  return def.kind === "ratio" ? Math.round(value * 10_000) / 10_000 : Math.round(value * 1_000_000) / 1_000_000;
}

// ─── Formatting (shared by the screen and tests) ─────────────────────────────

export function formatMetric(value: number | null | undefined, format: MetricFormat): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (format === "pct") return `${(value * 100).toFixed(1).replace(/\.0$/, "")}%`;
  if (format === "usd") return `$${value.toFixed(value >= 10 ? 2 : 4)}`;
  if (format === "ms") {
    if (value >= 3_600_000) return `${(value / 3_600_000).toFixed(1)} soat`;
    if (value >= 60_000) return `${Math.round(value / 60_000)} daq`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
    return `${Math.round(value)} ms`;
  }
  return Math.round(value).toLocaleString("en-US");
}
