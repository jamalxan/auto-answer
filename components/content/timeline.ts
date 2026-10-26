/**
 * Pure logic of the planner timeline ("Reja"): every planned post, Reels and
 * story of the window laid out by day and time in one column. Client-safe,
 * no React — the view (timeline-view.tsx) only renders what these return.
 */

import { MONTHS, utcToZoned, type PostCard, type PostTypeValue } from "./shared";

export type TypeGroup = "post" | "carousel" | "reels" | "story";

export const TYPE_GROUP: Record<PostTypeValue, TypeGroup> = {
  FEED_IMAGE: "post",
  FEED_VIDEO: "post",
  CAROUSEL: "carousel",
  REEL: "reels",
  TRIAL_REEL: "reels",
  STORY: "story",
};

export const GROUP_LABEL: Record<TypeGroup, string> = {
  post: "Post",
  carousel: "Karusel",
  reels: "Reels",
  story: "Story",
};

export const GROUP_ORDER: TypeGroup[] = ["reels", "post", "carousel", "story"];

export type TimelineEntry =
  | { kind: "post"; key: string; time: string; at: number; post: PostCard }
  /** Consecutive stories of one series on one day: one card, expandable. */
  | { kind: "series"; key: string; time: string; endTime: string; at: number; posts: PostCard[] };

export interface TimelineDay {
  date: string;
  entries: TimelineEntry[];
  counts: Record<TypeGroup, number>;
}

export const emptyCounts = (): Record<TypeGroup, number> => ({ post: 0, carousel: 0, reels: 0, story: 0 });

/** Days in posting order; inside a day by time; a story series collapses into one entry. */
export function buildTimeline(posts: PostCard[], tz: string): TimelineDay[] {
  const dated = posts
    .filter((p) => p.scheduledAt && !Number.isNaN(new Date(p.scheduledAt).getTime()))
    .map((p) => ({ post: p, at: new Date(p.scheduledAt!).getTime() }))
    .sort((a, b) => a.at - b.at || (a.post.seriesIndex ?? 0) - (b.post.seriesIndex ?? 0));

  const days = new Map<string, TimelineDay>();
  for (const { post, at } of dated) {
    const { date, time } = utcToZoned(new Date(at), tz);
    let day = days.get(date);
    if (!day) {
      day = { date, entries: [], counts: emptyCounts() };
      days.set(date, day);
    }
    day.counts[TYPE_GROUP[post.type]]++;
    const last = day.entries[day.entries.length - 1];
    if (post.type === "STORY" && post.seriesId && last) {
      const lastSeries = last.kind === "series" ? last.posts[0].seriesId : last.post.type === "STORY" ? last.post.seriesId : null;
      if (lastSeries === post.seriesId) {
        const group = last.kind === "series" ? last.posts : [last.post];
        day.entries[day.entries.length - 1] = { kind: "series", key: `s-${post.seriesId}-${date}`, time: last.time, endTime: time, at: last.at, posts: [...group, post] };
        continue;
      }
    }
    day.entries.push({ kind: "post", key: post.id, time, at, post });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Every ISO date from `from` to `to` inclusive. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const WEEKDAY_FULL = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];

export function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** "Bugun", "Ertaga", "Kecha" or "Payshanba"; the date line goes beside it. */
export function dayName(date: string, today: string): string {
  if (date === today) return "Bugun";
  if (date === addDays(today, 1)) return "Ertaga";
  if (date === addDays(today, -1)) return "Kecha";
  return WEEKDAY_FULL[weekdayIndex(date)];
}

/** "29 Oktabr" (with the year when it is not this year). */
export function dateLabel(date: string, today: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const year = y !== Number(today.slice(0, 4)) ? ` ${y}` : "";
  return `${d} ${MONTHS[m - 1]}${year}`;
}

/** "3 Reels · 2 Story · 1 Post" — only the groups that occur. */
export function countsLabel(counts: Record<TypeGroup, number>): string {
  return GROUP_ORDER.filter((g) => counts[g] > 0)
    .map((g) => `${counts[g]} ${GROUP_LABEL[g]}`)
    .join(" · ");
}

/** "12 daqiqadan keyin", "3 soatdan keyin", "2 kundan keyin", "1 soat oldin", "hozir". */
export function relativeTime(at: number, now: number): string {
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return "hozir";
  const [n, unit] =
    abs < 3_600_000 ? [Math.round(abs / 60_000), "daqiqa"] : abs < 86_400_000 ? [Math.round(abs / 3_600_000), "soat"] : [Math.round(abs / 86_400_000), "kun"];
  return diff > 0 ? `${n} ${unit}dan keyin` : `${n} ${unit} oldin`;
}

/** A gap worth showing between two consecutive cards of one day: two hours or more. */
export function gapLabel(fromMs: number, toMs: number): string | null {
  const gap = toMs - fromMs;
  if (gap < 2 * 3_600_000) return null;
  const hours = Math.floor(gap / 3_600_000);
  const minutes = Math.round((gap % 3_600_000) / 60_000);
  return minutes >= 5 ? `${hours} soat ${minutes} daqiqa bo'sh` : `${hours} soat bo'sh`;
}

/** When an entry's last item goes out (a series spans several minutes). */
export function entryEnd(entry: TimelineEntry): number {
  if (entry.kind === "post") return entry.at;
  const last = entry.posts[entry.posts.length - 1];
  return last.scheduledAt ? new Date(last.scheduledAt).getTime() : entry.at;
}

/** Where the "Hozir" line goes in today's entries: before the first one still ahead. */
export function nowIndex(entries: TimelineEntry[], now: number): number {
  const i = entries.findIndex((e) => e.at > now);
  return i === -1 ? entries.length : i;
}

/** Days with nothing planned between two planned days: "3 kun bo'sh". */
export function emptyRun(prev: string, next: string): number {
  return Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)) / 86_400_000) - 1;
}

/** Per-day counts for the density strip above the timeline. */
export function densityByDay(days: TimelineDay[], window: string[]): Array<{ date: string; counts: Record<TypeGroup, number>; total: number }> {
  const byDate = new Map(days.map((d) => [d.date, d.counts]));
  return window.map((date) => {
    const counts = byDate.get(date) ?? emptyCounts();
    return { date, counts, total: GROUP_ORDER.reduce((sum, g) => sum + counts[g], 0) };
  });
}
