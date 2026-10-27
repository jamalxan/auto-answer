/**
 * Meta Marketing API calls (audit 2026-10-26, phase 7) over metaJson
 * (timeouts, retries, 429, tenant cap, Meta error codes → ChannelError).
 *
 * Boosting an Instagram post uses the single Advantage+ structure of v25
 * (the legacy Advantage+ Shopping / App creation endpoints are gone):
 * campaign → ad set (daily budget, end_time always set) → creative from the
 * existing IG media → ad. Everything is created PAUSED and activated only
 * after all four exist; a failure in between deletes what was created, so a
 * half-built campaign can never spend.
 *
 * Amounts are minor units of the account currency (Meta's "offset").
 */

import { getMetaGraphApiVersion } from "@/lib/env";
import { metaJson } from "@/lib/channels/api";
import { facebookChannelsApp } from "@/lib/channels/meta-app";
import { ChannelError } from "@/lib/channels/types";

const LABEL = "Meta Ads";

export const ADS_SCOPES = ["ads_management", "ads_read", "business_management", "pages_show_list", "pages_read_engagement", "instagram_basic"];

/** Currencies Meta bills without cents. */
const NO_CENTS = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
export const currencyOffset = (currency: string) => (NO_CENTS.has(currency.toUpperCase()) ? 1 : 100);
export const formatMoney = (minor: number, currency: string) => `${(minor / currencyOffset(currency)).toFixed(currencyOffset(currency) === 1 ? 0 : 2)} ${currency}`;

export function adsGraph(path: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://graph.facebook.com/${getMetaGraphApiVersion()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export interface AdsContext {
  token: string;
  /** act_<id> */
  account: string;
  tenantId: string | null;
}

export interface BoostSpec {
  name: string;
  objective: "MESSAGES" | "ENGAGEMENT";
  igMediaId: string;
  igUserId: string;
  pageId: string;
  dailyBudgetMinor: number;
  startAt: Date;
  endAt: Date;
  countries: string[];
}

export interface BoostIds {
  campaignId: string;
  adSetId: string;
  creativeId: string;
  adId: string;
}

const post = <T>(ctx: AdsContext, path: string, fields: Record<string, string>) =>
  metaJson<T>(adsGraph(path), LABEL, { form: { ...fields, access_token: ctx.token }, tenantId: ctx.tenantId });

/** Set the status of any ads object (campaign, ad set, ad). */
export async function setAdsStatus(ctx: AdsContext, objectId: string, status: "ACTIVE" | "PAUSED" | "DELETED"): Promise<void> {
  await post(ctx, objectId, { status });
}

/** Build the whole boost PAUSED; returns the ids. Rolls back on any failure. */
export async function createBoost(ctx: AdsContext, spec: BoostSpec): Promise<BoostIds> {
  if (spec.endAt <= spec.startAt) throw new ChannelError("invalid", "Reklama muddati noto'g'ri");
  const created: string[] = [];
  try {
    const campaign = await post<{ id: string }>(ctx, `${ctx.account}/campaigns`, {
      name: spec.name,
      objective: "OUTCOME_ENGAGEMENT",
      status: "PAUSED",
      special_ad_categories: "[]",
      buying_type: "AUCTION",
    });
    created.push(campaign.id);

    const messages = spec.objective === "MESSAGES";
    const adSet = await post<{ id: string }>(ctx, `${ctx.account}/adsets`, {
      name: `${spec.name} · ad set`,
      campaign_id: campaign.id,
      daily_budget: String(spec.dailyBudgetMinor),
      billing_event: "IMPRESSIONS",
      optimization_goal: messages ? "CONVERSATIONS" : "POST_ENGAGEMENT",
      destination_type: messages ? "INSTAGRAM_DIRECT" : "ON_POST",
      bid_strategy: "LOWEST_COST_WITHOUT_CAP",
      promoted_object: JSON.stringify({ page_id: spec.pageId }),
      targeting: JSON.stringify({ geo_locations: { countries: spec.countries }, targeting_automation: { advantage_audience: 1 } }),
      start_time: spec.startAt.toISOString(),
      // Never open-ended: the ad set stops by itself even if we go silent.
      end_time: spec.endAt.toISOString(),
      status: "PAUSED",
    });
    created.push(adSet.id);

    const creative = await post<{ id: string }>(ctx, `${ctx.account}/adcreatives`, {
      name: `${spec.name} · creative`,
      object_id: spec.pageId,
      instagram_user_id: spec.igUserId,
      source_instagram_media_id: spec.igMediaId,
      ...(messages ? { call_to_action: JSON.stringify({ type: "INSTAGRAM_MESSAGE", value: { app_destination: "INSTAGRAM_DIRECT" } }) } : {}),
    });
    created.push(creative.id);

    const ad = await post<{ id: string }>(ctx, `${ctx.account}/ads`, {
      name: `${spec.name} · ad`,
      adset_id: adSet.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: "PAUSED",
    });
    created.push(ad.id);
    return { campaignId: campaign.id, adSetId: adSet.id, creativeId: creative.id, adId: ad.id };
  } catch (error) {
    for (const id of created.reverse()) await setAdsStatus(ctx, id, "DELETED").catch(() => {});
    throw error;
  }
}

/** Activation is the only step that lets money move: ad → ad set → campaign. */
export async function activateBoost(ctx: AdsContext, ids: Pick<BoostIds, "campaignId" | "adSetId" | "adId">): Promise<void> {
  await setAdsStatus(ctx, ids.adId, "ACTIVE");
  await setAdsStatus(ctx, ids.adSetId, "ACTIVE");
  await setAdsStatus(ctx, ids.campaignId, "ACTIVE");
}

/** Results Meta counts for our objectives. */
const RESULT_ACTIONS = new Set(["onsite_conversion.messaging_conversation_started_7d", "lead", "onsite_conversion.lead_grouped", "post_engagement"]);

export interface InsightRow {
  date: string;
  spendMinor: number;
  results: number;
}

/** Daily spend + results of a campaign over a date range (account timezone). */
export async function campaignInsights(ctx: AdsContext, campaignId: string, since: string, until: string, currency: string, objective: string): Promise<InsightRow[]> {
  const data = await metaJson<{ data?: Array<{ date_start: string; spend?: string; actions?: Array<{ action_type: string; value: string }> }> }>(
    adsGraph(`${campaignId}/insights`, { fields: "spend,actions", time_increment: "1", time_range: JSON.stringify({ since, until }), access_token: ctx.token }),
    LABEL,
    { tenantId: ctx.tenantId }
  );
  const offset = currencyOffset(currency);
  return (data.data ?? []).map((row) => {
    const actions = row.actions ?? [];
    const wanted = objective === "MESSAGES" ? actions.filter((a) => a.action_type !== "post_engagement") : actions.filter((a) => a.action_type === "post_engagement");
    return {
      date: row.date_start,
      spendMinor: Math.round(Number(row.spend ?? 0) * offset),
      results: wanted.filter((a) => RESULT_ACTIONS.has(a.action_type)).reduce((sum, a) => sum + (Number(a.value) || 0), 0),
    };
  });
}

export interface AdAccountChoice {
  adAccountId: string;
  name: string | null;
  currency: string;
  status: number;
}

export async function listAdAccounts(token: string): Promise<AdAccountChoice[]> {
  const data = await metaJson<{ data?: Array<{ id: string; name?: string; currency?: string; account_status?: number }> }>(
    adsGraph("me/adaccounts", { fields: "id,name,currency,account_status", limit: "50", access_token: token }),
    LABEL
  );
  return (data.data ?? []).map((a) => ({ adAccountId: a.id, name: a.name ?? null, currency: a.currency ?? "USD", status: a.account_status ?? 0 }));
}

// ─── Conversions API (business messaging) ──────────────────────────────────────

export interface SaleEvent {
  eventId: string;
  eventTime: Date;
  igAccountId: string;
  igScopedUserId: string;
  valueMinor: number | null;
  currency: string;
}

/** "Sold" from the CRM → Purchase on the dataset, so delivery looks for buyers, not chatters. */
export async function sendSaleEvent(token: string, datasetId: string, event: SaleEvent, tenantId: string | null): Promise<void> {
  const data = [
    {
      event_name: "Purchase",
      event_time: Math.floor(event.eventTime.getTime() / 1000),
      event_id: event.eventId,
      action_source: "business_messaging",
      messaging_channel: "instagram",
      user_data: { ig_account_id: event.igAccountId, ig_sid: event.igScopedUserId },
      custom_data: event.valueMinor !== null ? { currency: event.currency, value: event.valueMinor / currencyOffset(event.currency) } : { currency: event.currency },
    },
  ];
  const result = await metaJson<{ events_received?: number }>(adsGraph(`${datasetId}/events`), LABEL, { form: { data: JSON.stringify(data), access_token: token }, tenantId });
  if (!result.events_received) throw new ChannelError("invalid", "Meta eventni qabul qilmadi");
}

// ─── OAuth ─────────────────────────────────────────────────────────────────────

export function adsAuthorizeUrl(redirectUri: string, state: string): string {
  const { appId } = facebookChannelsApp();
  if (!appId) throw new ChannelError("invalid", "FACEBOOK_CHANNELS_APP_ID sozlanmagan");
  const url = new URL(`https://www.facebook.com/${getMetaGraphApiVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  const configId = process.env.FACEBOOK_ADS_CONFIG_ID?.trim();
  if (configId) {
    url.searchParams.set("config_id", configId);
    url.searchParams.set("override_default_response_type", "true");
  } else {
    url.searchParams.set("scope", ADS_SCOPES.join(","));
  }
  return url.toString();
}

/** code → long-lived user token with the ads scopes. */
export async function adsTokenFromCode(code: string, redirectUri: string): Promise<string> {
  const { appId, secret } = facebookChannelsApp();
  if (!appId || !secret) throw new ChannelError("invalid", "FACEBOOK_CHANNELS_APP_ID / FACEBOOK_CHANNELS_APP_SECRET sozlanmagan");
  const short = await metaJson<{ access_token: string }>(adsGraph("oauth/access_token", { client_id: appId, client_secret: secret, redirect_uri: redirectUri, code }), LABEL);
  const long = await metaJson<{ access_token: string }>(
    adsGraph("oauth/access_token", { grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: short.access_token }),
    LABEL
  );
  return long.access_token;
}
