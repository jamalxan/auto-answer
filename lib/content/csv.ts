/**
 * ETAP 13 Faza 2 — CSV import, the pure half (spec §5.9 FR-I1, FR-I2).
 *
 *   parseCsv(text)                 RFC 4180-ish: BOM, CRLF / LF / CR, quoted
 *                                  fields with "" escapes, delimiters and line
 *                                  breaks inside quotes; "," or ";" (Excel in a
 *                                  ru / uz locale saves with ";").
 *   normalizeCsv(text, ctx)        header → columns, every data row → a
 *                                  normalized post + its errors / warnings.
 *
 * No I/O here: the account list, campaigns, time zone and "now" come in the
 * context, so the preview and the commit judge a row the same way. Media
 * facts are unknown before the files are fetched, so a row is checked with
 * the kind the URL suggests (extension) and placeholder dimensions; the real
 * kind is re-checked at commit after the download.
 */

import { CONTENT_LIMITS, MEDIA } from "./config";
import { userTagSchema, type PostInput, type PostTypeValue, type UserTag } from "./schema";
import { zonedToUtc } from "./time";
import { scheduleIssues, validatePost, type MediaFacts } from "./validate";
import { isInternalHostname } from "@/lib/integrations/net";

export const CSV_MAX_ROWS = 200;
export const CSV_MAX_CHARS = 1_000_000;
export const CSV_MAX_MEDIA = 10;

export class CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvError";
  }
}

// ─── Parser ─────────────────────────────────────────────────────────────────

export type CsvDelimiter = "," | ";";

/** The delimiter of the first record: whichever of "," / ";" occurs more often outside quotes. */
export function detectDelimiter(text: string): CsvDelimiter {
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch === ",") commas++;
    else if (!quoted && ch === ";") semis++;
  }
  return semis > commas ? ";" : ",";
}

/** Records of the file as arrays of raw field strings (no trimming). */
export function parseCsv(input: string, delimiter?: CsvDelimiter): { records: string[][]; delimiter: CsvDelimiter } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiter ?? detectDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let recordLine = 1;
  let line = 1;

  const endField = () => {
    record.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      continue;
    }
    if (ch === sep) {
      endField();
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    // A stray quote inside an unquoted field is kept as a character (Excel does the same).
    field += ch;
    fieldStarted = true;
  }
  if (quoted) throw new CsvError(`Qo'shtirnoq (") yopilmagan — ${recordLine}-qatordan boshlangan maydonni tekshiring`);
  if (field !== "" || record.length > 0) endRecord();
  return { records, delimiter: sep };
}

// ─── Columns ────────────────────────────────────────────────────────────────

const range = (prefix: string) => Array.from({ length: CSV_MAX_MEDIA }, (_, i) => `${prefix}_${i + 1}`);

export const CSV_COLUMNS = [
  "text",
  "date",
  "time",
  "account",
  "type",
  ...range("media_url"),
  ...range("alt_text"),
  "cover_url",
  "cover_frame_ms",
  "share_to_feed",
  "first_comment",
  "collaborators",
  "user_tags",
  "draft",
  "autopublish",
  "campaign_keyword",
] as const;

const ALIASES: Record<string, string> = { caption: "text", username: "account", media_url: "media_url_1", alt_text: "alt_text_1", auto_publish: "autopublish" };

export function normalizeHeader(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ALIASES[key] ?? key;
}

// ─── Normalization ──────────────────────────────────────────────────────────

export interface CsvAccount {
  id: string;
  username: string;
  canPublish: boolean;
}

export interface CsvCampaign {
  kind: "automation" | "trigger";
  id: string;
  name: string;
  instagramAccountId: string;
  keywords: string[];
  /** Active on a published post right now: re-linking would switch it off (link-campaign M5). */
  live: boolean;
}

export interface CsvContext {
  accounts: CsvAccount[];
  campaigns: CsvCampaign[];
  timezone: string;
  now: Date;
  carouselMax: number;
  maxCollaborators: number;
}

export type MediaKindValue = "IMAGE" | "VIDEO";

export interface CsvMediaItem {
  url: string;
  /** From the URL extension; null when the URL does not say. The download decides at commit. */
  guessedKind: MediaKindValue | null;
  altText?: string;
  userTags?: UserTag[];
}

export interface CsvRow {
  /** The spreadsheet row number (the header is row 1). */
  row: number;
  errors: string[];
  warnings: string[];
  accountId: string | null;
  accountUsername: string | null;
  /** What the file asked for: POST, REEL, TRIAL_REEL, STORY. */
  requestedType: string;
  /** The post type the row becomes (POST + 2 media → CAROUSEL, POST + 1 video → FEED_VIDEO). */
  type: PostTypeValue;
  caption: string | null;
  firstComment: string | null;
  collaborators: string[];
  shareToFeed: boolean;
  thumbOffsetMs: number | null;
  coverUrl: string | null;
  autoPublish: boolean;
  draft: boolean;
  media: CsvMediaItem[];
  /** ISO instant of date + time in the workspace zone, or null. */
  scheduledAt: string | null;
  campaignKeyword: string | null;
  campaign: { kind: "automation" | "trigger"; id: string; name: string } | null;
}

export interface CsvPreview {
  rows: CsvRow[];
  fileErrors: string[];
  fileWarnings: string[];
  total: number;
  valid: number;
  timezone: string;
  delimiter: CsvDelimiter;
}

const TYPE_ALIASES: Record<string, string> = {
  "": "POST",
  POST: "POST",
  FEED: "POST",
  FEED_IMAGE: "POST",
  FEED_VIDEO: "POST",
  CAROUSEL: "POST",
  KARUSEL: "POST",
  REEL: "REEL",
  REELS: "REEL",
  TRIAL_REEL: "TRIAL_REEL",
  TRIAL_REELS: "TRIAL_REEL",
  TRIAL: "TRIAL_REEL",
  STORY: "STORY",
  STORIES: "STORY",
};

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;

export function guessKind(url: string): MediaKindValue | null {
  try {
    const path = new URL(url).pathname;
    if (IMAGE_EXT.test(path)) return "IMAGE";
    if (VIDEO_EXT.test(path)) return "VIDEO";
  } catch {
    /* invalid url: reported elsewhere */
  }
  return null;
}

/** POST becomes a carousel, a feed image or a feed video by its media (composer rule FR-C2). */
export function resolveType(requested: string, kinds: MediaKindValue[]): PostTypeValue {
  if (requested === "REEL" || requested === "TRIAL_REEL" || requested === "STORY") return requested;
  if (kinds.length >= 2) return "CAROUSEL";
  return kinds[0] === "VIDEO" ? "FEED_VIDEO" : "FEED_IMAGE";
}

const TRUE = new Set(["1", "true", "yes", "y", "ha", "on", "x"]);
const FALSE = new Set(["0", "false", "no", "n", "yo'q", "yoq", "off"]);

function parseBool(raw: string, fallback: boolean, column: string, errors: string[]): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  errors.push(`${column}: "${raw.trim().slice(0, 20)}" tushunarsiz — 1 yoki 0 yozing`);
  return fallback;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-24", "24.10.2026", "24/10/2026" → "2026-10-24", or null. */
export function parseDate(raw: string): string | null {
  const v = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(v);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "9:05", "19:00", "19:00:00" → "19:00", or null. */
export function parseTime(raw: string): string | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${pad(h)}:${pad(m)}`;
}

/** "@ali:0.5:0.4; @vali" → tags; coordinates are optional (Reels / Story). */
export function parseUserTags(raw: string, errors: string[]): UserTag[] {
  const out: UserTag[] = [];
  for (const part of raw.split(";").map((p) => p.trim()).filter(Boolean)) {
    const [name, xs, ys, ...rest] = part.split(":").map((p) => p.trim());
    const hasCoords = xs !== undefined || ys !== undefined;
    const x = xs === undefined ? undefined : Number(xs);
    const y = ys === undefined ? undefined : Number(ys);
    if (rest.length || (hasCoords && (xs === undefined || ys === undefined || !Number.isFinite(x) || !Number.isFinite(y)))) {
      errors.push(`user_tags: "${part.slice(0, 40)}" — @username:x:y ko'rinishida yozing (x, y 0 dan 1 gacha)`);
      continue;
    }
    const parsed = userTagSchema.safeParse(hasCoords ? { username: name, x, y } : { username: name });
    if (!parsed.success) {
      errors.push(`user_tags: "${part.slice(0, 40)}" — ${parsed.error.issues[0]?.path[0] === "username" ? "username noto'g'ri" : "x va y 0 dan 1 gacha bo'lsin"}`);
      continue;
    }
    out.push(parsed.data);
  }
  return out;
}

/** Static URL check (DNS is checked again at download time). */
export function mediaUrlIssue(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "havola noto'g'ri";
  }
  if (url.protocol !== "https:") return "faqat https:// havola qabul qilinadi";
  if (url.username || url.password) return "havolada login/parol bo'lmasin";
  if (isInternalHostname(url.hostname)) return "ichki (xususiy) manzildan yuklab bo'lmaydi";
  return null;
}

/**
 * Preview facts for the field matrix. The duration is a placeholder inside
 * every range (3 s) and dimensions are unknown, so only the rules that do
 * not depend on the file itself (counts, kinds, captions, tags, cover…) fire.
 */
export function placeholderFacts(kinds: MediaKindValue[], cover: boolean): MediaFacts[] {
  const facts: MediaFacts[] = kinds.map((kind, i) => ({ id: `csv-${i}`, kind, status: "READY", width: null, height: null, durationMs: kind === "VIDEO" ? MEDIA.reelMinMs : null, sizeBytes: 0 }));
  if (cover) facts.push({ id: "csv-cover", kind: "IMAGE", status: "READY", width: null, height: null, durationMs: null, sizeBytes: 0 });
  return facts;
}

/** The PostInput a row becomes, with media ids supplied by the caller (placeholders or real ids). */
export function rowToPostInput(row: CsvRow, mediaIds: string[], coverMediaId: string | null): PostInput {
  return {
    instagramAccountId: row.accountId ?? "",
    type: row.type,
    caption: row.caption ?? undefined,
    firstComment: row.firstComment ?? undefined,
    collaborators: row.collaborators,
    shareToFeed: row.shareToFeed,
    coverMediaId,
    thumbOffsetMs: row.thumbOffsetMs,
    autoPublish: row.autoPublish,
    manualReason: row.autoPublish ? null : "USER_CHOICE",
    media: row.media.map((m, i) => ({
      mediaId: mediaIds[i],
      ...(m.altText ? { altText: m.altText } : {}),
      ...(m.userTags?.length ? { userTags: m.userTags } : {}),
    })),
  };
}

/** Field-matrix issues of a row for given media kinds (preview: guessed; commit: downloaded). */
export function rowIssues(row: CsvRow, kinds: MediaKindValue[], ctx: Pick<CsvContext, "carouselMax" | "maxCollaborators" | "now">): string[] {
  const facts = placeholderFacts(kinds, Boolean(row.coverUrl));
  const input = rowToPostInput({ ...row, type: resolveType(row.requestedType, kinds) }, kinds.map((_, i) => `csv-${i}`), row.coverUrl ? "csv-cover" : null);
  return validatePost(input, facts, { carouselMax: ctx.carouselMax, maxCollaborators: ctx.maxCollaborators, now: ctx.now }).map((issue) => {
    const media = /^media\[(\d+)\]/.exec(issue.field);
    return media ? `media_url_${Number(media[1]) + 1}: ${issue.message}` : issue.message;
  });
}

/** The kind a row is checked with before download: the URL's, else what the type wants. */
function previewKind(guessed: MediaKindValue | null, requested: string): MediaKindValue {
  if (guessed) return guessed;
  return requested === "REEL" || requested === "TRIAL_REEL" ? "VIDEO" : "IMAGE";
}

function normalizeRow(cells: Record<string, string>, rowNumber: number, ctx: CsvContext, seenCampaigns: Set<string>): CsvRow {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (key: string) => (cells[key] ?? "").trim();

  // Account
  let account: CsvAccount | undefined;
  const handle = get("account").replace(/^@+/, "");
  if (handle) {
    account = ctx.accounts.find((a) => a.username.toLowerCase() === handle.toLowerCase());
    if (!account) errors.push(`account: @${handle.slice(0, 30)} bu workspace'da ulanmagan`);
  } else if (ctx.accounts.length === 1) {
    account = ctx.accounts[0];
    warnings.push(`account bo'sh — @${account.username} olindi`);
  } else errors.push("account kiritilmagan");

  // Type
  const rawType = get("type").toUpperCase().replace(/[\s-]+/g, "_");
  const requestedType = TYPE_ALIASES[rawType];
  if (!requestedType) errors.push(`type: "${get("type").slice(0, 20)}" — POST, REEL, TRIAL_REEL yoki STORY yozing`);
  const requested = requestedType ?? "POST";

  // Media (gaps are allowed: media_url_1 empty, media_url_2 set → one item)
  const media: CsvMediaItem[] = [];
  for (let i = 1; i <= CSV_MAX_MEDIA; i++) {
    const url = get(`media_url_${i}`);
    const alt = get(`alt_text_${i}`);
    if (!url) {
      if (alt) warnings.push(`alt_text_${i} bor, lekin media_url_${i} bo'sh — e'tiborsiz qoldirildi`);
      continue;
    }
    const issue = mediaUrlIssue(url);
    if (issue) errors.push(`media_url_${i}: ${issue}`);
    if (alt.length > CONTENT_LIMITS.altTextChars) errors.push(`alt_text_${i}: ${CONTENT_LIMITS.altTextChars} belgidan oshmasin`);
    media.push({ url, guessedKind: guessKind(url), ...(alt ? { altText: alt } : {}) });
  }
  if (media.some((m) => !m.guessedKind)) warnings.push("Ba'zi havolalarda fayl turi ko'rinmaydi — turi yuklab olinganda aniqlanadi");

  const coverUrl = get("cover_url") || null;
  if (coverUrl) {
    const issue = mediaUrlIssue(coverUrl);
    if (issue) errors.push(`cover_url: ${issue}`);
  }
  let thumbOffsetMs: number | null = null;
  const frame = get("cover_frame_ms");
  if (frame) {
    const n = Number(frame);
    if (!Number.isInteger(n) || n < 0 || n > MEDIA.reelMaxMs) errors.push("cover_frame_ms: millisekund butun son bo'lsin (0 … 900000)");
    else thumbOffsetMs = n;
  }

  const tagsRaw = get("user_tags");
  if (tagsRaw) {
    const tags = parseUserTags(tagsRaw, errors);
    if (tags.length && media[0]) media[0].userTags = tags;
    else if (tags.length) errors.push("user_tags: media yo'q — odam belgilab bo'lmaydi");
  }

  const draft = parseBool(get("draft"), false, "draft", errors);
  let autoPublish = parseBool(get("autopublish"), true, "autopublish", errors);
  if (autoPublish && account && !account.canPublish) {
    autoPublish = false;
    warnings.push(`@${account.username}da avto-publish ruxsati yo'q — qo'lda e'lon (Telegram) rejimida rejalashtiriladi`);
  }
  const shareToFeed = parseBool(get("share_to_feed"), true, "share_to_feed", errors);

  const kinds = media.map((m) => previewKind(m.guessedKind, requested));
  const type = resolveType(requested, kinds);
  if (requested === "POST" && type === "FEED_VIDEO") warnings.push("Video post Instagram'da Reels sifatida chiqadi");

  let caption: string | null = get("text") || null;
  if (type === "STORY" && caption) {
    warnings.push("Story'da caption bo'lmaydi — text saqlanmaydi");
    caption = null;
  }

  // Time
  const dateRaw = get("date");
  const timeRaw = get("time");
  let scheduledAt: string | null = null;
  const date = dateRaw ? parseDate(dateRaw) : null;
  const time = timeRaw ? parseTime(timeRaw) : null;
  if (dateRaw && !date) errors.push(`date: "${dateRaw.slice(0, 20)}" — YYYY-MM-DD yoki DD.MM.YYYY ko'rinishida yozing`);
  if (timeRaw && !time) errors.push(`time: "${timeRaw.slice(0, 20)}" — HH:mm ko'rinishida yozing`);
  if (date && time) {
    const at = zonedToUtc(date, time, ctx.timezone);
    scheduledAt = at.toISOString();
    const when = scheduleIssues(at, ctx.now).map((i) => `${dateRaw} ${timeRaw}: ${i.message}`);
    if (draft) warnings.push(...when);
    else errors.push(...when);
  } else if (!draft && !(dateRaw && !date) && !(timeRaw && !time)) {
    errors.push("date va time kerak (yoki draft=1 — vaqtsiz draft)");
  } else if (draft && (date || time) && !(date && time)) {
    warnings.push("Vaqt to'liq emas (date va time ikkalasi kerak) — draft vaqtsiz saqlanadi");
  }

  // Campaign
  const campaignKeyword = get("campaign_keyword") || null;
  let campaign: CsvRow["campaign"] = null;
  if (campaignKeyword && account) {
    const key = campaignKeyword.toLowerCase();
    const matches = ctx.campaigns.filter((c) => c.instagramAccountId === account.id && c.keywords.some((k) => k.trim().toLowerCase() === key));
    const usable = matches.find((c) => !c.live);
    if (!matches.length) warnings.push(`campaign_keyword: @${account.username}da «${campaignKeyword.slice(0, 30)}» kalit so'zli kampaniya topilmadi — post kampaniyasiz yaratiladi`);
    else if (!usable) warnings.push(`campaign_keyword: «${campaignKeyword.slice(0, 30)}» kampaniyasi hozir boshqa chiqqan postda ishlayapti — ulanmaydi`);
    else if (seenCampaigns.has(usable.id)) warnings.push(`campaign_keyword: "${usable.name}" kampaniyasi yuqoridagi qatorga ulangan — bitta kampaniya bitta postga ulanadi`);
    else {
      seenCampaigns.add(usable.id);
      campaign = { kind: usable.kind, id: usable.id, name: usable.name };
    }
  }

  const row: CsvRow = {
    row: rowNumber,
    errors,
    warnings,
    accountId: account?.id ?? null,
    accountUsername: account?.username ?? null,
    requestedType: requested,
    type,
    caption,
    firstComment: get("first_comment") || null,
    collaborators: get("collaborators").split(",").map((c) => c.trim()).filter(Boolean),
    shareToFeed,
    thumbOffsetMs,
    coverUrl,
    autoPublish,
    draft,
    media,
    scheduledAt,
    campaignKeyword,
    campaign,
  };
  // Drafts may be incomplete (like the composer's); a row that will be scheduled must be publishable.
  const issues = rowIssues(row, kinds, ctx);
  if (draft) {
    const hard = issues.filter((m) => m.startsWith("Video feed post"));
    errors.push(...hard);
    warnings.push(...issues.filter((m) => !hard.includes(m)).map((m) => `Rejalashtirishdan oldin tuzating: ${m}`));
  } else errors.push(...issues);
  return row;
}

/** The whole preview of a file. Throws CsvError only for a file that cannot be read at all. */
export function normalizeCsv(text: string, ctx: CsvContext): CsvPreview {
  if (text.length > CSV_MAX_CHARS) throw new CsvError("Fayl juda katta (1 MB dan oshmasin)");
  const { records, delimiter } = parseCsv(text);
  const nonEmpty = records.map((cells, i) => ({ cells, row: i + 1 })).filter((r) => r.cells.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) throw new CsvError("Fayl bo'sh");
  const [header, ...data] = nonEmpty;
  const keys = header.cells.map(normalizeHeader);
  const known = new Set<string>(CSV_COLUMNS);
  if (!keys.some((k) => known.has(k))) throw new CsvError("Sarlavha qatori topilmadi — birinchi qatorda ustun nomlari bo'lsin (text, date, time, account, …). Shablonni yuklab oling.");

  const fileErrors: string[] = [];
  const fileWarnings: string[] = [];
  const unknown = [...new Set(keys.filter((k) => k && !known.has(k)))];
  if (unknown.length) fileWarnings.push(`Noma'lum ustunlar e'tiborsiz qoldirildi: ${unknown.slice(0, 10).join(", ")}`);
  const dupes = keys.filter((k, i) => k && keys.indexOf(k) !== i);
  if (dupes.length) fileErrors.push(`Ustun ikki marta yozilgan: ${[...new Set(dupes)].join(", ")}`);
  if (data.length === 0) fileErrors.push("Sarlavhadan keyin birorta qator yo'q");
  if (data.length > CSV_MAX_ROWS) fileErrors.push(`Bir faylda ko'pi bilan ${CSV_MAX_ROWS} ta qator (${data.length} ta bor) — faylni bo'ling`);
  if (fileErrors.length) return { rows: [], fileErrors, fileWarnings, total: data.length, valid: 0, timezone: ctx.timezone, delimiter };

  const seenCampaigns = new Set<string>();
  const rows = data.map(({ cells, row }) => {
    const map: Record<string, string> = {};
    keys.forEach((key, i) => {
      if (key && known.has(key)) map[key] = cells[i] ?? "";
    });
    const normalized = normalizeRow(map, row, ctx, seenCampaigns);
    if (cells.length > keys.length && cells.slice(keys.length).some((c) => c.trim())) normalized.warnings.push("Sarlavhadan ortiq ustunlar e'tiborsiz qoldirildi");
    return normalized;
  });
  return { rows, fileErrors, fileWarnings, total: rows.length, valid: rows.filter((r) => r.errors.length === 0).length, timezone: ctx.timezone, delimiter };
}

// ─── Template ───────────────────────────────────────────────────────────────

const csvCell = (v: string) => (/[",;\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The downloadable template: BOM (so Excel reads UTF-8), the header, two example rows. */
export function csvTemplate(username = "akkaunt"): string {
  const header = ["text", "date", "time", "account", "type", "media_url_1", "media_url_2", "alt_text_1", "alt_text_2", "cover_url", "cover_frame_ms", "share_to_feed", "first_comment", "collaborators", "user_tags", "draft", "autopublish", "campaign_keyword"];
  const examples = [
    ["Yangi kolleksiya! Narxini bilish uchun \"narx\" deb yozing #mebel", "2026-11-01", "19:00", `@${username}`, "POST", "https://example.com/rasm1.jpg", "https://example.com/rasm2.jpg", "Divan, old tomondan", "Divan, yon tomondan", "", "", "", "Batafsil: direct'ga yozing", "", "@do_st:0.5:0.6", "0", "1", "narx"],
    ["Ustaxonadan kadrlar", "2026-11-02", "12:30", `@${username}`, "REEL", "https://example.com/video.mp4", "", "", "", "https://example.com/muqova.jpg", "", "1", "", "hamkor_akkaunt", "", "0", "1", ""],
  ];
  return `﻿${[header, ...examples].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
