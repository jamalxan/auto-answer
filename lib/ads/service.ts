/**
 * Ads module (audit 2026-10-26, phase 7). The AI never spends: it proposes a
 * boost for a post that did ≥ 2× its account median, a workspace OWNER
 * approves it in the panel (budget, days, objective), and only then the
 * campaign is built and activated. A 15-minute guard reads insights and
 * pauses on the daily / monthly cap or a too-high CPL; a "sold" deal in the
 * CRM goes back to Meta as a Conversions API Purchase.
 *
 * Every query is scoped by workspaceId; the ad token never leaves the server.
 */

import { prisma } from "@/lib/db/client";
import { decryptPayload, encryptPayload } from "@/lib/channels/vault";
import { ChannelError } from "@/lib/channels/types";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import {
  DEFAULT_BOOST_DAYS,
  PROPOSAL_TTL_DAYS,
  accountStop,
  checkApproval,
  cplTooHigh,
  isBoostCandidate,
  type Caps,
  type PauseReason,
} from "./guardrails";
import { activateBoost, campaignInsights, createBoost, currencyOffset, formatMoney, sendSaleEvent, setAdsStatus, type AdsContext } from "./meta-ads";

const LAUNCH_STUCK_MS = 15 * 60_000;
const CAPI_MAX_ATTEMPTS = 5;
const PAUSE_TEXT: Record<PauseReason | "owner", string> = {
  daily_cap: "kunlik chegaraga yetdi",
  monthly_cap: "oylik chegaraga yetdi",
  cpl: "lid narxi (CPL) chegaradan oshdi",
  owner: "egasi to'xtatdi",
};

export class AdsError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type AccountRow = NonNullable<Awaited<ReturnType<typeof prisma.adAccount.findFirst>>>;

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const monthKey = (d: Date) => d.toISOString().slice(0, 7);

function adsContext(account: AccountRow): AdsContext {
  const secret = decryptPayload<{ accessToken: string }>(account);
  if (!secret.accessToken) throw new ChannelError("auth", "Reklama akkaunti tokeni yo'q — qayta ulang");
  return { token: secret.accessToken, account: account.adAccountId, tenantId: account.workspaceId };
}

const caps = (a: AccountRow): Caps => ({ dailyCapMinor: a.dailyCapMinor, monthlyCapMinor: a.monthlyCapMinor, cplMaxMinor: a.cplMaxMinor });

// ─── Accounts ──────────────────────────────────────────────────────────────────

export async function saveAdAccount(workspaceId: string, input: { adAccountId: string; name: string | null; currency: string; token: string }) {
  const sealed = encryptPayload({ accessToken: input.token });
  return prisma.adAccount.upsert({
    where: { workspaceId_adAccountId: { workspaceId, adAccountId: input.adAccountId } },
    create: { workspaceId, adAccountId: input.adAccountId, name: input.name, currency: input.currency, ...sealed },
    update: { name: input.name, currency: input.currency, ...sealed, status: "ACTIVE", lastError: null },
  });
}

export interface AccountSettings {
  pageId?: string | null;
  igUserId?: string | null;
  datasetId?: string | null;
  dailyCapMinor?: number | null;
  monthlyCapMinor?: number | null;
  cplMaxMinor?: number | null;
  defaultDailyBudgetMinor?: number | null;
  saleValueMinor?: number | null;
}

const MONEY_FIELDS = ["dailyCapMinor", "monthlyCapMinor", "cplMaxMinor", "defaultDailyBudgetMinor", "saleValueMinor"] as const;

export async function updateAdAccount(workspaceId: string, id: string, settings: AccountSettings, role: string) {
  // Caps decide how much money may move: owner only, like approvals.
  if (role !== "OWNER") throw new AdsError(403, "Reklama sozlamalarini faqat workspace egasi o'zgartiradi");
  const account = await prisma.adAccount.findFirst({ where: { id, workspaceId } });
  if (!account) throw new AdsError(404, "Reklama akkaunti topilmadi");
  const data: Record<string, unknown> = {};
  for (const key of ["pageId", "igUserId", "datasetId"] as const) {
    if (key in settings) data[key] = settings[key]?.trim() || null;
  }
  for (const key of MONEY_FIELDS) {
    if (!(key in settings)) continue;
    const value = settings[key];
    if (value !== null && (!Number.isInteger(value) || (value as number) < 0)) throw new AdsError(400, `${key} butun musbat son bo'lishi kerak`);
    data[key] = value;
  }
  if (typeof data.dailyCapMinor === "number" && typeof data.monthlyCapMinor === "number" && data.dailyCapMinor > data.monthlyCapMinor) {
    throw new AdsError(400, "Kunlik chegara oylikdan katta bo'lmasin");
  }
  return prisma.adAccount.update({ where: { id }, data });
}

export async function revokeAdAccount(workspaceId: string, id: string): Promise<boolean> {
  const live = await prisma.adProposal.count({ where: { workspaceId, accountId: id, status: { in: ["LIVE", "LAUNCHING"] } } });
  if (live > 0) throw new AdsError(409, "Avval ishlab turgan kampaniyalarni to'xtating");
  const result = await prisma.adAccount.updateMany({ where: { id, workspaceId }, data: { ...encryptPayload({ accessToken: "" }), status: "REVOKED" } });
  return result.count > 0;
}

/** What the panel shows: never a token or ciphertext. */
export async function adsOverview(workspaceId: string, now = new Date()) {
  const accounts = await prisma.adAccount.findMany({ where: { workspaceId, status: { not: "REVOKED" } }, orderBy: { createdAt: "asc" } });
  const proposals = await prisma.adProposal.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 });
  const spend = await monthSpend(accounts.map((a) => a.id), now);
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      adAccountId: a.adAccountId,
      name: a.name,
      currency: a.currency,
      offset: currencyOffset(a.currency),
      pageId: a.pageId,
      igUserId: a.igUserId,
      datasetId: a.datasetId,
      dailyCapMinor: a.dailyCapMinor,
      monthlyCapMinor: a.monthlyCapMinor,
      cplMaxMinor: a.cplMaxMinor,
      defaultDailyBudgetMinor: a.defaultDailyBudgetMinor,
      saleValueMinor: a.saleValueMinor,
      status: a.status,
      lastError: a.lastError,
      todaySpentMinor: spend.get(a.id)?.today ?? 0,
      monthSpentMinor: spend.get(a.id)?.month ?? 0,
    })),
    proposals,
  };
}

async function monthSpend(accountIds: string[], now: Date): Promise<Map<string, { today: number; month: number }>> {
  const out = new Map<string, { today: number; month: number }>();
  if (accountIds.length === 0) return out;
  const proposals = await prisma.adProposal.findMany({ where: { accountId: { in: accountIds } }, select: { id: true, accountId: true } });
  if (proposals.length === 0) return out;
  const days = await prisma.adSpendDay.findMany({ where: { proposalId: { in: proposals.map((p) => p.id) }, date: { startsWith: monthKey(now) } } });
  const today = dayKey(now);
  for (const day of days) {
    const accountId = proposals.find((p) => p.id === day.proposalId)!.accountId;
    const row = out.get(accountId) ?? { today: 0, month: 0 };
    row.month += day.spendMinor;
    if (day.date === today) row.today += day.spendMinor;
    out.set(accountId, row);
  }
  return out;
}

// ─── Proposals ─────────────────────────────────────────────────────────────────

/** Winning posts of accounts linked to an ad account → PROPOSED boosts (one per post), owner told once. */
export async function suggestBoosts(now = new Date()): Promise<number> {
  const accounts = await prisma.adAccount.findMany({ where: { status: "ACTIVE", igUserId: { not: null }, pageId: { not: null } } });
  let created = 0;
  for (const account of accounts) {
    const ig = await prisma.instagramAccount.findFirst({ where: { workspaceId: account.workspaceId, instagramId: account.igUserId! }, select: { id: true } });
    if (!ig) continue;
    const stats = await prisma.contentPostStat.findMany({
      where: { workspaceId: account.workspaceId, instagramAccountId: ig.id, publishedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) } },
      orderBy: { score: "desc" },
      take: 20,
    });
    for (const stat of stats.filter((s) => isBoostCandidate(s, now)).slice(0, 3)) {
      const offset = currencyOffset(account.currency);
      const daily = account.defaultDailyBudgetMinor ?? 5 * offset;
      try {
        await prisma.adProposal.create({
          data: {
            workspaceId: account.workspaceId,
            accountId: account.id,
            kind: "BOOST",
            objective: "MESSAGES",
            statId: stat.id,
            igMediaId: stat.igMediaId,
            permalink: stat.permalink,
            reason: `Post akkaunt medianasidan ${stat.score?.toFixed(1)}× ko'p ko'rildi (${stat.views} ko'rish)`,
            dailyBudgetMinor: daily,
            durationDays: DEFAULT_BOOST_DAYS,
            expiresAt: new Date(now.getTime() + PROPOSAL_TTL_DAYS * 86_400_000),
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code === "P2002") continue; // already proposed for this post
        throw error;
      }
      created++;
      await notifyWorkspaceChats(
        account.workspaceId,
        `📈 <b>Reklama taklifi</b>\nPost medianadan ${esc(stat.score?.toFixed(1) ?? "?")}× yaxshi ishladi.\nTaklif: kuniga ${esc(formatMoney(daily, account.currency))}, ${DEFAULT_BOOST_DAYS} kun, DM'ga yo'naltirish.\nPanelda tasdiqlang yoki rad eting — tasdiqsiz pul sarflanmaydi.`
      ).catch(() => 0);
    }
  }
  return created;
}

export interface ApproveInput {
  workspaceId: string;
  proposalId: string;
  userId: string;
  role: string;
  dailyBudgetMinor?: number;
  durationDays?: number;
  objective?: "MESSAGES" | "ENGAGEMENT";
  now?: Date;
}

async function liveOf(accountId: string, excludeId?: string) {
  return prisma.adProposal.findMany({ where: { accountId, status: { in: ["LIVE", "LAUNCHING", "APPROVED"] }, ...(excludeId ? { id: { not: excludeId } } : {}) }, select: { dailyBudgetMinor: true, endAt: true } });
}

async function verdictFor(account: AccountRow, role: string, proposal: { id: string; dailyBudgetMinor: number; durationDays: number }, now: Date) {
  const spend = await monthSpend([account.id], now);
  return checkApproval({
    role,
    caps: caps(account),
    accountStatus: account.status,
    offset: currencyOffset(account.currency),
    proposal,
    live: await liveOf(account.id, proposal.id),
    monthSpentMinor: spend.get(account.id)?.month ?? 0,
    now,
  });
}

/** Owner approves (optionally editing budget / days / objective) → built PAUSED → activated → LIVE. */
export async function approveProposal(input: ApproveInput) {
  const now = input.now ?? new Date();
  const proposal = await prisma.adProposal.findFirst({ where: { id: input.proposalId, workspaceId: input.workspaceId } });
  if (!proposal) throw new AdsError(404, "Taklif topilmadi");
  if (proposal.status !== "PROPOSED") throw new AdsError(409, "Bu taklif allaqachon ko'rib chiqilgan");
  if (proposal.expiresAt && proposal.expiresAt < now) throw new AdsError(409, "Taklif muddati o'tgan");
  const account = await prisma.adAccount.findFirst({ where: { id: proposal.accountId, workspaceId: input.workspaceId } });
  if (!account) throw new AdsError(404, "Reklama akkaunti topilmadi");
  if (!account.pageId || !account.igUserId) throw new AdsError(409, "Akkauntga Facebook sahifa va Instagram ID'ni kiriting");

  const terms = {
    id: proposal.id,
    dailyBudgetMinor: input.dailyBudgetMinor ?? proposal.dailyBudgetMinor,
    durationDays: input.durationDays ?? proposal.durationDays,
  };
  const verdict = await verdictFor(account, input.role, terms, now);
  if (!verdict.ok) throw new AdsError(422, verdict.reason);

  const startAt = now;
  const endAt = new Date(now.getTime() + terms.durationDays * 86_400_000);
  const claim = await prisma.adProposal.updateMany({
    where: { id: proposal.id, status: "PROPOSED" },
    data: {
      status: "LAUNCHING",
      approvedById: input.userId,
      approvedAt: now,
      dailyBudgetMinor: terms.dailyBudgetMinor,
      durationDays: terms.durationDays,
      objective: input.objective ?? proposal.objective,
      startAt,
      endAt,
    },
  });
  if (claim.count === 0) throw new AdsError(409, "Bu taklif allaqachon ko'rib chiqilgan");

  const ctx = adsContext(account);
  let ids: Awaited<ReturnType<typeof createBoost>> | null = null;
  try {
    ids = await createBoost(ctx, {
      name: `SocialAuto boost ${proposal.igMediaId}`,
      objective: input.objective ?? (proposal.objective as "MESSAGES" | "ENGAGEMENT"),
      igMediaId: proposal.igMediaId,
      igUserId: account.igUserId,
      pageId: account.pageId,
      dailyBudgetMinor: terms.dailyBudgetMinor,
      startAt,
      endAt,
      countries: (process.env.ADS_DEFAULT_COUNTRIES ?? "UZ").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean),
    });
    await prisma.adProposal.update({ where: { id: proposal.id }, data: ids });
    await activateBoost(ctx, ids);
    return prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "LIVE", error: null } });
  } catch (error) {
    // Created but not (fully) active: make sure nothing can spend.
    if (ids) await setAdsStatus(ctx, ids.campaignId, "PAUSED").catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    await prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
    throw new AdsError(502, `Reklama ishga tushmadi: ${message}`);
  }
}

export async function rejectProposal(workspaceId: string, proposalId: string): Promise<boolean> {
  const result = await prisma.adProposal.updateMany({ where: { id: proposalId, workspaceId, status: "PROPOSED" }, data: { status: "REJECTED" } });
  return result.count > 0;
}

/** Anyone who can manage the workspace may stop spending; that never needs approval. */
export async function pauseProposal(workspaceId: string, proposalId: string, reason: PauseReason | "owner" = "owner") {
  const proposal = await prisma.adProposal.findFirst({ where: { id: proposalId, workspaceId, status: "LIVE" } });
  if (!proposal?.campaignId) throw new AdsError(404, "Ishlab turgan kampaniya topilmadi");
  const account = await prisma.adAccount.findFirstOrThrow({ where: { id: proposal.accountId } });
  await setAdsStatus(adsContext(account), proposal.campaignId, "PAUSED");
  return prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "PAUSED", pauseReason: reason } });
}

/** Resuming moves money again: the same owner + caps check as an approval. */
export async function resumeProposal(workspaceId: string, proposalId: string, role: string, now = new Date()) {
  const proposal = await prisma.adProposal.findFirst({ where: { id: proposalId, workspaceId, status: "PAUSED" } });
  if (!proposal?.campaignId) throw new AdsError(404, "To'xtatilgan kampaniya topilmadi");
  if (proposal.endAt && proposal.endAt <= now) throw new AdsError(409, "Kampaniya muddati tugagan");
  const account = await prisma.adAccount.findFirstOrThrow({ where: { id: proposal.accountId, workspaceId } });
  const remainingDays = Math.max(1, Math.ceil(((proposal.endAt?.getTime() ?? now.getTime()) - now.getTime()) / 86_400_000));
  const verdict = await verdictFor(account, role, { id: proposal.id, dailyBudgetMinor: proposal.dailyBudgetMinor, durationDays: remainingDays }, now);
  if (!verdict.ok) throw new AdsError(422, verdict.reason);
  const spend = await monthSpend([account.id], now);
  const stop = accountStop(caps(account), spend.get(account.id)?.today ?? 0, spend.get(account.id)?.month ?? 0);
  if (stop) throw new AdsError(422, `Bugun davom ettirib bo'lmaydi: ${PAUSE_TEXT[stop]}`);
  if (cplTooHigh(account.cplMaxMinor, proposal.spendMinor, proposal.results) && proposal.pauseReason === "cpl") {
    throw new AdsError(422, "Lid narxi chegaradan yuqori — CPL chegarasini o'zgartiring yoki yangi reklama yarating");
  }
  await setAdsStatus(adsContext(account), proposal.campaignId, "ACTIVE");
  return prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "LIVE", pauseReason: null } });
}

// ─── Guard ─────────────────────────────────────────────────────────────────────

export interface GuardSummary {
  checked: number;
  paused: number;
  finished: number;
  expired: number;
  failed: number;
}

async function pauseFor(account: AccountRow, ctx: AdsContext, proposal: { id: string; campaignId: string | null }, reason: PauseReason, summary: GuardSummary) {
  if (proposal.campaignId) await setAdsStatus(ctx, proposal.campaignId, "PAUSED");
  await prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "PAUSED", pauseReason: reason } });
  summary.paused++;
}

/** Every 15 min: insights → caps / CPL → pause; ended → DONE; old proposals → EXPIRED; stuck launches → FAILED. */
export async function guardAds(now = new Date()): Promise<GuardSummary> {
  const summary: GuardSummary = { checked: 0, paused: 0, finished: 0, expired: 0, failed: 0 };
  summary.expired = (await prisma.adProposal.updateMany({ where: { status: "PROPOSED", expiresAt: { lt: now } }, data: { status: "EXPIRED" } })).count;

  const stuck = await prisma.adProposal.findMany({ where: { status: "LAUNCHING", updatedAt: { lt: new Date(now.getTime() - LAUNCH_STUCK_MS) } } });
  for (const proposal of stuck) {
    const account = await prisma.adAccount.findFirst({ where: { id: proposal.accountId } });
    if (account && proposal.campaignId) await setAdsStatus(adsContext(account), proposal.campaignId, "PAUSED").catch(() => {});
    await prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "FAILED", error: "Ishga tushirish to'xtab qoldi — Ads Manager'da tekshiring" } });
    summary.failed++;
  }

  const accounts = await prisma.adAccount.findMany({ where: { status: "ACTIVE" } });
  for (const account of accounts) {
    const live = await prisma.adProposal.findMany({ where: { accountId: account.id, status: "LIVE" } });
    if (live.length === 0) continue;
    let ctx: AdsContext;
    try {
      ctx = adsContext(account);
    } catch {
      continue;
    }
    const monthStart = `${monthKey(now)}-01`;
    for (const proposal of live) {
      if (!proposal.campaignId) continue;
      try {
        const since = proposal.startAt && dayKey(proposal.startAt) < monthStart ? monthStart : dayKey(proposal.startAt ?? now);
        const rows = await campaignInsights(ctx, proposal.campaignId, since, dayKey(now), account.currency, proposal.objective);
        for (const row of rows) {
          await prisma.adSpendDay.upsert({
            where: { proposalId_date: { proposalId: proposal.id, date: row.date } },
            create: { proposalId: proposal.id, date: row.date, spendMinor: row.spendMinor, results: row.results },
            update: { spendMinor: row.spendMinor, results: row.results },
          });
        }
        const all = await prisma.adSpendDay.findMany({ where: { proposalId: proposal.id } });
        proposal.spendMinor = all.reduce((s, d) => s + d.spendMinor, 0);
        proposal.results = all.reduce((s, d) => s + d.results, 0);
        await prisma.adProposal.update({ where: { id: proposal.id }, data: { spendMinor: proposal.spendMinor, results: proposal.results, insightsAt: now } });
        summary.checked++;
      } catch (error) {
        if (error instanceof ChannelError && error.kind === "auth") {
          await prisma.adAccount.update({ where: { id: account.id }, data: { status: "ERROR", lastError: error.message } });
          await notifyWorkspaceChats(account.workspaceId, `⚠️ <b>Reklama akkaunti ulanishi ishlamayapti</b>\n${esc(account.name ?? account.adAccountId)}\nKampaniyalar holatini Ads Manager'da tekshiring va qayta ulang.`).catch(() => 0);
          break;
        }
        console.warn("[ads] insights failed:", error instanceof Error ? error.message : error);
      }
    }

    const spend = (await monthSpend([account.id], now)).get(account.id) ?? { today: 0, month: 0 };
    const stop = accountStop(caps(account), spend.today, spend.month);
    const paused: string[] = [];
    for (const proposal of live) {
      try {
        if (proposal.endAt && proposal.endAt <= now) {
          await prisma.adProposal.update({ where: { id: proposal.id }, data: { status: "DONE" } });
          summary.finished++;
        } else if (stop) {
          await pauseFor(account, ctx, proposal, stop, summary);
          paused.push(`${proposal.igMediaId}: ${PAUSE_TEXT[stop]}`);
        } else if (cplTooHigh(account.cplMaxMinor, proposal.spendMinor, proposal.results)) {
          await pauseFor(account, ctx, proposal, "cpl", summary);
          const cpl = proposal.results ? formatMoney(Math.round(proposal.spendMinor / proposal.results), account.currency) : "lid yo'q";
          paused.push(`${proposal.igMediaId}: ${PAUSE_TEXT.cpl} (${cpl})`);
        }
      } catch (error) {
        console.error("[ads] pause failed:", error instanceof Error ? error.message : error);
      }
    }
    if (paused.length) {
      await notifyWorkspaceChats(account.workspaceId, `⏸ <b>Reklama avtomatik to'xtatildi</b>\n${paused.map(esc).join("\n")}\nDavom ettirish — panelda, sizning tasdig'ingiz bilan.`).catch(() => 0);
    }
  }
  return summary;
}

// ─── Conversions API ───────────────────────────────────────────────────────────

/** From moveDeal on WON: queue one Purchase for the ad account that runs this IG account. */
export async function queueSaleEvent(workspaceId: string, dealId: string): Promise<boolean> {
  const deal = await prisma.crmDeal.findFirst({ where: { id: dealId, workspaceId }, select: { contactId: true } });
  if (!deal) return false;
  const contact = await prisma.crmContact.findFirst({ where: { id: deal.contactId, workspaceId }, select: { instagramAccountId: true } });
  if (!contact) return false;
  const ig = await prisma.instagramAccount.findFirst({ where: { id: contact.instagramAccountId, workspaceId }, select: { instagramId: true } });
  if (!ig) return false;
  const account = await prisma.adAccount.findFirst({ where: { workspaceId, igUserId: ig.instagramId, datasetId: { not: null }, status: "ACTIVE" } });
  if (!account) return false;
  try {
    await prisma.capiEvent.create({ data: { workspaceId, accountId: account.id, dealId, eventName: "Purchase" } });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false; // the same deal won again
    throw error;
  }
}

export async function sendPendingSaleEvents(now = new Date()): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  const pending = await prisma.capiEvent.findMany({ where: { status: "PENDING" }, take: 50, orderBy: { createdAt: "asc" } });
  for (const event of pending) {
    const account = await prisma.adAccount.findFirst({ where: { id: event.accountId, workspaceId: event.workspaceId } });
    const deal = await prisma.crmDeal.findFirst({ where: { id: event.dealId, workspaceId: event.workspaceId }, select: { wonAt: true, contactId: true } });
    const contact = deal ? await prisma.crmContact.findFirst({ where: { id: deal.contactId }, select: { igUserId: true } }) : null;
    if (!account?.datasetId || !account.igUserId || !deal?.wonAt || !contact) {
      await prisma.capiEvent.update({ where: { id: event.id }, data: { status: "FAILED", error: "Deal / dataset topilmadi yoki sotuv bekor qilingan" } });
      out.failed++;
      continue;
    }
    try {
      await sendSaleEvent(adsContext(account).token, account.datasetId, { eventId: event.dealId, eventTime: deal.wonAt, igAccountId: account.igUserId, igScopedUserId: contact.igUserId, valueMinor: account.saleValueMinor, currency: account.currency }, event.workspaceId);
      await prisma.capiEvent.update({ where: { id: event.id }, data: { status: "SENT", sentAt: now, attempts: { increment: 1 }, error: null } });
      out.sent++;
    } catch (error) {
      const attempts = event.attempts + 1;
      const permanent = error instanceof ChannelError && (error.kind === "auth" || error.kind === "permission" || error.kind === "invalid");
      await prisma.capiEvent.update({
        where: { id: event.id },
        data: { attempts, error: (error instanceof Error ? error.message : String(error)).slice(0, 500), status: permanent || attempts >= CAPI_MAX_ATTEMPTS ? "FAILED" : "PENDING" },
      });
      out.failed++;
    }
  }
  return out;
}
