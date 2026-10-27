/**
 * Content intelligence, step 2 (audit "Tahlil"): the multimodal model tags a
 * post from what it actually contains: video frames (one a second, the first
 * three seconds sent apart), the audio transcript, the caption, the length
 * and the shape. The tags feed the typical-error checks and the
 * tag → result correlations of the weekly report.
 *
 * Video analysis costs far more than a text answer, so it runs only when the
 * owner asks ("Tahlil qilish" or "last 30 days") and within a monthly
 * per-workspace limit (CONTENT_ANALYSIS_MONTHLY_LIMIT, default 30; the tariff
 * limits of phase 8 replace it). Work is queued as PENDING rows and the
 * worker takes two per minute.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db/client";
import { getLlmProvider, type LlmImage, type LLMProvider } from "@/lib/assistant/llm/provider";
import { transcribeVoice } from "@/lib/assistant/stt";
import { getMediaDetails } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { defaultExec, probeVideo, type ExecFn } from "@/lib/content/media-process";
import { keywordCovered, runChecks, type ContentTags } from "./checks";

const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;
const MAX_FRAMES = 60;
const SENT_FRAMES = 12;
const FIRST_SECONDS = 3;

export function monthlyAnalysisLimit(): number {
  const raw = (process.env.CONTENT_ANALYSIS_MONTHLY_LIMIT ?? "").trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function analysesUsed(workspaceId: string, now = new Date()): Promise<number> {
  return prisma.contentAnalysis.count({ where: { workspaceId, status: { in: ["DONE", "PENDING"] }, createdAt: { gte: monthStart(now) } } });
}

export class AnalysisError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Queue posts for analysis (the owner's button). Returns how many were queued. */
export async function queueAnalyses(workspaceId: string, statIds: string[], now = new Date()): Promise<number> {
  // The tariff's cap once billing is enforced (phase 8), else the env default.
  const { videoAnalysisCap } = await import("@/lib/billing/limits");
  const limit = (await videoAnalysisCap(workspaceId)) ?? monthlyAnalysisLimit();
  const used = await analysesUsed(workspaceId, now);
  const room = Math.max(0, limit - used);
  if (room === 0) throw new AnalysisError(429, `Bu oy uchun video tahlil limiti tugadi (${limit} ta)`);
  const stats = await prisma.contentPostStat.findMany({ where: { id: { in: statIds }, workspaceId }, select: { id: true } });
  if (stats.length === 0) throw new AnalysisError(404, "Post topilmadi");
  const existing = await prisma.contentAnalysis.findMany({ where: { statId: { in: stats.map((s) => s.id) } }, select: { statId: true, status: true } });
  let queued = 0;
  for (const stat of stats) {
    if (queued >= room) break;
    const row = existing.find((e) => e.statId === stat.id);
    if (row && (row.status === "PENDING" || row.status === "DONE")) continue;
    if (row) await prisma.contentAnalysis.update({ where: { statId: stat.id }, data: { status: "PENDING", error: null, createdAt: now } });
    else await prisma.contentAnalysis.create({ data: { workspaceId, statId: stat.id, status: "PENDING", createdAt: now } });
    queued++;
  }
  return queued;
}

/** "Last 30 days": every not-yet-analysed post of the account, newest first, within the limit. */
export async function queueRecent(workspaceId: string, accountId: string, now = new Date()): Promise<number> {
  const stats = await prisma.contentPostStat.findMany({
    where: { workspaceId, instagramAccountId: accountId, publishedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
    orderBy: { publishedAt: "desc" },
    select: { id: true },
  });
  return stats.length ? queueAnalyses(workspaceId, stats.map((s) => s.id), now) : 0;
}

// ─── Media extraction ──────────────────────────────────────────────────────────

export interface ExtractedVideo {
  /** One frame a second, JPEG, in order (index = second). */
  frames: Buffer[];
  audio: Buffer | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
}

export interface AnalyzeDeps {
  provider?: LLMProvider | null;
  download?: (url: string) => Promise<Buffer>;
  extractVideo?: (video: Buffer) => Promise<ExtractedVideo>;
  transcribe?: (audio: Buffer) => Promise<string | null>;
  mediaUrls?: (statId: string) => Promise<{ kind: "video" | "image"; urls: string[] }>;
  slotScore?: (workspaceId: string, accountId: string, at: Date) => Promise<number | null>;
}

async function defaultDownload(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`media download ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_DOWNLOAD_BYTES) throw new Error("media too large");
  const buf = Buffer.from(await response.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error("media too large");
  return buf;
}

export async function extractWithFfmpeg(video: Buffer, exec: ExecFn = defaultExec): Promise<ExtractedVideo> {
  const dir = await mkdtemp(path.join(tmpdir(), "ci-"));
  try {
    const input = path.join(dir, "in.mp4");
    await writeFile(input, video);
    const probe = await probeVideo(input, exec).catch(() => null);
    const ffmpeg = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
    await exec(ffmpeg, ["-y", "-i", input, "-vf", "fps=1,scale=384:-2", "-frames:v", String(MAX_FRAMES), "-q:v", "5", path.join(dir, "f%03d.jpg")], { timeoutMs: 120_000 });
    const names = (await readdir(dir)).filter((n) => /^f\d+\.jpg$/.test(n)).sort();
    const frames = await Promise.all(names.map((n) => readFile(path.join(dir, n))));
    let audio: Buffer | null = null;
    try {
      const out = path.join(dir, "a.ogg");
      await exec(ffmpeg, ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-t", "170", "-c:a", "libopus", "-b:a", "24k", out], { timeoutMs: 120_000 });
      audio = await readFile(out);
    } catch {
      audio = null; // no audio track, or no opus encoder
    }
    return {
      frames,
      audio,
      width: probe?.width ?? null,
      height: probe?.height ?? null,
      durationSec: probe?.durationMs ? Math.round(probe.durationMs / 100) / 10 : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function defaultTranscribe(audio: Buffer): Promise<string | null> {
  const result = await transcribeVoice({ buffer: audio, mime: "audio/ogg" }).catch(() => null);
  return result?.text?.trim() || null;
}

async function defaultMediaUrls(statId: string): Promise<{ kind: "video" | "image"; urls: string[] }> {
  const stat = await prisma.contentPostStat.findUnique({ where: { id: statId }, select: { igMediaId: true, instagramAccountId: true } });
  if (!stat) throw new Error("stat not found");
  const account = await prisma.instagramAccount.findUnique({ where: { id: stat.instagramAccountId }, select: { accessToken: true } });
  if (!account) throw new Error("account not found");
  const media = await getMediaDetails(decryptToken(account.accessToken), stat.igMediaId);
  if (media.media_type === "VIDEO" && media.media_url) return { kind: "video", urls: [media.media_url] };
  if (media.media_type === "CAROUSEL_ALBUM") {
    const children = media.children?.data ?? [];
    const video = children.find((c) => c.media_type === "VIDEO" && c.media_url);
    if (video?.media_url) return { kind: "video", urls: [video.media_url] };
    return { kind: "image", urls: children.map((c) => c.media_url).filter((u): u is string => Boolean(u)).slice(0, 6) };
  }
  return { kind: "image", urls: media.media_url ? [media.media_url] : [] };
}

async function defaultSlotScore(workspaceId: string, accountId: string, at: Date): Promise<number | null> {
  try {
    const { bestTimes, zonedWeekHour } = await import("@/lib/content/insights");
    const times = await bestTimes(workspaceId, accountId, { now: at });
    if (!times.scores) return null;
    const { weekday, hour } = zonedWeekHour(at, times.timezone);
    return times.scores[weekday]?.[hour] ?? null;
  } catch {
    return null;
  }
}

/** First three seconds apart, then evenly spread frames: at most SENT_FRAMES images. */
export function pickFrames(frames: Buffer[]): { first: Buffer[]; rest: Buffer[] } {
  const first = frames.slice(0, FIRST_SECONDS);
  const remaining = frames.slice(FIRST_SECONDS);
  const slots = SENT_FRAMES - first.length;
  if (remaining.length <= slots) return { first, rest: remaining };
  const step = remaining.length / slots;
  return { first, rest: Array.from({ length: slots }, (_, i) => remaining[Math.floor(i * step)]) };
}

// ─── The model call ────────────────────────────────────────────────────────────

const TAG_SCHEMA = {
  type: "object",
  properties: {
    hookType: { type: "string", enum: ["savol", "natija", "muammo", "shok", "boshqa"] },
    format: { type: "string", enum: ["talking_head", "b_roll", "ekran_yozuvi", "rasm", "karusel", "boshqa"] },
    topic: { type: "string" },
    hasSubtitles: { type: "boolean" },
    hasCta: { type: "boolean" },
    ctaKeyword: { type: "string" },
    hookStartSec: { type: "number" },
    firstFrameHasText: { type: "boolean" },
    textInUnsafeZone: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["hookType", "format", "topic", "hasSubtitles", "hasCta", "ctaKeyword", "hookStartSec", "firstFrameHasText", "textInUnsafeZone", "note"],
};

const SYSTEM = `Siz Instagram kontent tahlilchisisiz. Sizga post kadrlari (videoda: avval birinchi 3 soniya, keyin qolgan qismdan namunalar), audio transkript va caption beriladi.
Faqat ko'rganingizga asoslaning, taxmin qilmang. Javob JSON:
- hookType: birinchi 3 soniyadagi ilgak turi (savol | natija | muammo | shok | boshqa)
- format: talking_head (odam kameraga gapiradi) | b_roll | ekran_yozuvi | rasm | karusel | boshqa
- topic: mavzu, 2–5 so'z, o'zbekcha
- hasSubtitles: videoda gapga mos yozuv (subtitr) bormi; rasm bo'lsa false
- hasCta: tomoshabinga aniq harakat aytilganmi (comment yozing, DM, havola…)
- ctaKeyword: comment'ga yozish so'ralgan kalit so'z ("NARX"), bo'lmasa ""
- hookStartSec: asosiy ilgak (diqqat tortuvchi gap yoki kadr) necha soniyada boshlanadi; rasm uchun 0
- firstFrameHasText: birinchi kadrda o'qiladigan matn bormi
- textInUnsafeZone: muhim matn pastki 20% yoki o'ng chetda (Instagram tugmalari ostida) qolganmi
- note: post nima uchun ishlagan yoki ishlamaganini 1–2 gapda, ko'rsatilgan natija bilan bog'lab`;

export interface AnalysisOutcome {
  status: "DONE" | "FAILED" | "SKIPPED";
  issues: string[];
  error?: string;
}

/** Analyse one queued post. Never throws: the row records what happened. */
export async function analyzeStat(statId: string, deps: AnalyzeDeps = {}): Promise<AnalysisOutcome> {
  const stat = await prisma.contentPostStat.findUnique({ where: { id: statId } });
  if (!stat) return { status: "FAILED", issues: [], error: "stat not found" };
  const provider = deps.provider === undefined ? getLlmProvider() : deps.provider;
  if (!provider) {
    await prisma.contentAnalysis.update({ where: { statId }, data: { status: "FAILED", error: "LLM sozlanmagan" } });
    return { status: "FAILED", issues: [], error: "LLM sozlanmagan" };
  }
  try {
    const media = await (deps.mediaUrls ?? defaultMediaUrls)(statId);
    if (media.urls.length === 0) throw new Error("Media URL topilmadi");
    const download = deps.download ?? defaultDownload;
    const images: LlmImage[] = [];
    let transcript: string | null = null;
    let aspect: number | null = null;
    let durationSec: number | null = null;
    let firstCount = 0;
    if (media.kind === "video") {
      const video = await download(media.urls[0]);
      const extracted = await (deps.extractVideo ?? ((buf) => extractWithFfmpeg(buf)))(video);
      if (extracted.frames.length === 0) throw new Error("Videodan kadr olinmadi");
      const { first, rest } = pickFrames(extracted.frames);
      firstCount = first.length;
      for (const frame of [...first, ...rest]) images.push({ mediaType: "image/jpeg", base64: frame.toString("base64") });
      if (extracted.audio) transcript = await (deps.transcribe ?? defaultTranscribe)(extracted.audio);
      aspect = extracted.width && extracted.height ? Math.round((extracted.width / extracted.height) * 1000) / 1000 : null;
      durationSec = extracted.durationSec;
    } else {
      for (const url of media.urls) images.push({ mediaType: "image/jpeg", base64: (await download(url)).toString("base64") });
    }

    const facts = [
      `Post turi: ${stat.productType ?? stat.mediaType}${durationSec ? `, ${durationSec} s` : ""}`,
      media.kind === "video" ? `Rasmlar: dastlabki ${firstCount} tasi 0–${firstCount - 1}-soniyalar, qolganlari videoning davomidan.` : `Rasmlar: post rasmlari (${images.length} ta).`,
      `Natija: ${stat.views ?? "?"} ko'rish, akkaunt medianasiga nisbatan ${stat.score ?? "?"}×; saqlash ${stat.saves ?? "?"}, ulashish ${stat.shares ?? "?"}, lid ${stat.bizLeads}.`,
      `Caption: ${(stat.caption ?? "").slice(0, 1500) || "(yo'q)"}`,
      `Transkript: ${transcript ? transcript.slice(0, 3000) : "(yo'q)"}`,
    ].join("\n");
    const response = await provider.complete({
      system: SYSTEM,
      messages: [{ role: "user", content: facts }],
      schema: TAG_SCHEMA,
      schemaName: "content_tags",
      temperature: 0.1,
      maxTokens: 600,
      timeoutMs: 90_000,
      images,
      usage: { workspaceId: stat.workspaceId, kind: "content_analysis" },
    });
    const raw = (response.json && typeof response.json === "object" ? response.json : {}) as Record<string, unknown>;
    const tags: ContentTags & { note?: string } = {
      hookType: (raw.hookType as ContentTags["hookType"]) ?? null,
      format: (raw.format as ContentTags["format"]) ?? null,
      topic: typeof raw.topic === "string" ? raw.topic.slice(0, 80) : null,
      hasSubtitles: media.kind === "video" ? Boolean(raw.hasSubtitles) : null,
      hasCta: typeof raw.hasCta === "boolean" ? raw.hasCta : null,
      ctaKeyword: typeof raw.ctaKeyword === "string" && raw.ctaKeyword.trim() ? raw.ctaKeyword.trim().slice(0, 40) : null,
      hookStartSec: typeof raw.hookStartSec === "number" ? raw.hookStartSec : null,
      firstFrameHasText: typeof raw.firstFrameHasText === "boolean" ? raw.firstFrameHasText : null,
      textInUnsafeZone: typeof raw.textInUnsafeZone === "boolean" ? raw.textInUnsafeZone : null,
      aspect,
      durationSec,
      note: typeof raw.note === "string" ? raw.note.slice(0, 400) : undefined,
    };

    let keywordLinked: boolean | null = null;
    if (tags.ctaKeyword) {
      const [automations, triggers] = await Promise.all([
        prisma.automation.findMany({ where: { instagramAccountId: stat.instagramAccountId }, select: { isActive: true, postId: true, matchAnyPost: true, matchAnyWord: true, keywords: true } }),
        prisma.triggerCampaign.findMany({ where: { instagramAccountId: stat.instagramAccountId, triggerType: "COMMENT" }, select: { active: true, mediaScope: true, mediaIds: true, keywords: true } }),
      ]);
      keywordLinked = keywordCovered(tags.ctaKeyword, stat.igMediaId, automations, triggers);
    }
    const slotScore = await (deps.slotScore ?? defaultSlotScore)(stat.workspaceId, stat.instagramAccountId, stat.publishedAt);
    const issues = runChecks({ isVideo: media.kind === "video", tags, keywordLinked, slotScore });

    await prisma.contentAnalysis.update({
      where: { statId },
      data: {
        status: "DONE",
        tags: JSON.parse(JSON.stringify(tags)),
        transcript: transcript?.slice(0, 8000) ?? null,
        issues,
        model: response.model,
        costUsd: provider.costUsd(response.inputTokens, response.outputTokens, response.model),
        error: null,
        analyzedAt: new Date(),
      },
    });
    return { status: "DONE", issues };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const text = /ENOENT/.test(message) && /ff(mpeg|probe)/.test(message) ? "Serverda ffmpeg o'rnatilmagan" : message.slice(0, 300);
    await prisma.contentAnalysis.update({ where: { statId }, data: { status: "FAILED", error: text } });
    return { status: "FAILED", issues: [], error: text };
  }
}

/** Worker tick: a couple of queued analyses at a time (they are slow and costly). */
export async function processAnalysisQueue(limit = 2, deps: AnalyzeDeps = {}): Promise<number> {
  const pending = await prisma.contentAnalysis.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: limit, select: { statId: true } });
  for (const row of pending) await analyzeStat(row.statId, deps);
  return pending.length;
}
