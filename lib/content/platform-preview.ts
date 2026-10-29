/**
 * What each channel does with a Content Scheduler post, for the live preview and
 * the "other networks" picker. Mirrors lib/channels/crosspost.ts (formatFor) and
 * the adapters' limits; kept free of server imports so the composer can use it.
 */

import capabilities from "@/lib/channels/capabilities.json";
import type { PostTypeValue } from "./schema";

export type CrossChannel = "facebook" | "threads" | "youtube";
export type PreviewPlatform = "instagram" | CrossChannel;
export type PlatformFormat = "text" | "image" | "video" | "carousel" | "reel" | "short";

export const PLATFORM_LABEL: Record<PreviewPlatform, string> = { instagram: "Instagram", facebook: "Facebook", threads: "Threads", youtube: "YouTube" };
export const THREADS_TEXT_LIMIT = 500;
export const YOUTUBE_TITLE_MAX = 100;

const FORMAT_OF: Partial<Record<PostTypeValue, PlatformFormat>> = {
  FEED_IMAGE: "image",
  FEED_VIDEO: "video",
  REEL: "video",
  TRIAL_REEL: "video",
  CAROUSEL: "carousel",
};

/** A Reel is a Reel on Facebook and a Short on YouTube; elsewhere a plain video. */
export function formatFor(type: PostTypeValue, channel: CrossChannel, hasMedia = true): PlatformFormat {
  if (!hasMedia) return "text";
  if (type === "REEL" || type === "TRIAL_REEL") {
    if (channel === "facebook") return "reel";
    if (channel === "youtube") return "short";
  }
  return FORMAT_OF[type] ?? "image";
}

/** null = the channel takes this post; otherwise the reason it cannot. */
export function channelBlocker(channel: CrossChannel, type: PostTypeValue, hasMedia: boolean): string | null {
  if (type === "STORY") return "Story boshqa tarmoqqa chiqmaydi";
  const format = formatFor(type, channel, hasMedia);
  const allowed = capabilities[channel].publish_formats as string[];
  if (!allowed.includes(format)) {
    if (channel === "youtube") return "YouTube faqat video va Shorts qabul qiladi";
    return "Bu format shu tarmoqda qo'llanmaydi";
  }
  return null;
}

/** YouTube title: first caption line, `#Shorts` for a Short, at most 100 characters. */
export function youtubeTitle(caption: string, format: PlatformFormat): string {
  const clean = (s: string) => s.replace(/[<>]/g, "").trim();
  let title = clean(caption.trim().split("\n")[0] ?? "") || "Video";
  if (format === "short" && !/#shorts\b/i.test(title)) title = `${title.slice(0, YOUTUBE_TITLE_MAX - 8).trim()} #Shorts`;
  if (title.length > YOUTUBE_TITLE_MAX) title = `${title.slice(0, YOUTUBE_TITLE_MAX - 1).trim()}…`;
  return title;
}

/** Threads cuts a post at 500 characters. */
export function threadsText(caption: string): { text: string; cut: boolean } {
  const text = caption.trim();
  return text.length > THREADS_TEXT_LIMIT ? { text: text.slice(0, THREADS_TEXT_LIMIT), cut: true } : { text, cut: false };
}
