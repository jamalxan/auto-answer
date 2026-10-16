/**
 * ETAP 9.4 — workspace settings of the points / badges engine. Defaults live
 * in code; `EngagementSettings` stores only what the owner changed (an empty
 * `pointsRules` / `badgeRules` means "defaults"). Comment points are OFF by
 * default (owner decision: they would turn every comment into a reward).
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { unprocessable } from "./errors";

export const POINT_REASONS = ["comment", "giveaway_entry", "referral_qualified", "purchase"] as const;
export type PointReason = (typeof POINT_REASONS)[number];

export interface PointsRule {
  points: number;
  enabled: boolean;
}
export type PointsRules = Record<PointReason, PointsRule>;

/** Uzbek labels for the ledger / timeline. */
export const POINT_REASON_LABELS: Record<PointReason, string> = {
  comment: "Izoh",
  giveaway_entry: "Giveaway'da qatnashish",
  referral_qualified: "Taklif qilingan do'st",
  purchase: "Xarid",
};

export const DEFAULT_POINTS_RULES: PointsRules = {
  comment: { points: 1, enabled: false },
  giveaway_entry: { points: 2, enabled: true },
  referral_qualified: { points: 10, enabled: true },
  purchase: { points: 20, enabled: true },
};

export interface BadgeRule {
  key: string;
  name: string;
  threshold: number;
}

export const DEFAULT_BADGES: BadgeRule[] = [
  { key: "faol", name: "Faol", threshold: 10 },
  { key: "elchi", name: "Elchi", threshold: 50 },
  { key: "vip", name: "VIP", threshold: 150 },
];

export const MAX_BADGES = 20;

export interface EngagementSettingsView {
  pointsRules: PointsRules;
  badgeRules: BadgeRule[];
}

const pointsValue = z
  .number({ message: "Ball son bo'lishi kerak" })
  .int("Ball butun son bo'lsin")
  .min(0, "Ball 0 dan kam bo'lmasin")
  .max(1000, "Ball 1000 dan oshmasin");

const ruleSchema = z.union([
  pointsValue.transform((points) => ({ points, enabled: undefined as boolean | undefined })),
  z.object({ points: pointsValue, enabled: z.boolean().optional() }),
]);

const badgeSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, "Nishon kaliti kiritilmagan")
    .max(30, "Nishon kaliti 30 belgidan oshmasin")
    .regex(/^[a-z0-9_-]+$/, "Nishon kaliti kichik lotin harf, raqam, - yoki _ bo'lsin"),
  name: z.string().trim().min(1, "Nishon nomi kiritilmagan").max(30, "Nishon nomi 30 belgidan oshmasin"),
  threshold: z
    .number({ message: "Chegara son bo'lishi kerak" })
    .int("Chegara butun son bo'lsin")
    .min(1, "Chegara kamida 1 bo'lsin")
    .max(100_000, "Chegara 100000 dan oshmasin"),
});

export const settingsInputSchema = z.object({
  pointsRules: z.record(z.string(), ruleSchema).default({}),
  badgeRules: z.array(badgeSchema).max(MAX_BADGES, `Nishonlar ${MAX_BADGES} tadan oshmasin`).default([]),
});
export type EngagementSettingsInput = z.input<typeof settingsInputSchema>;

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

/** Merge stored overrides over the defaults; unknown reasons / malformed entries are ignored. */
export function mergePointsRules(stored: unknown): PointsRules {
  const out = {} as PointsRules;
  const source = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  for (const reason of POINT_REASONS) {
    const base = DEFAULT_POINTS_RULES[reason];
    const raw = source[reason];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[reason] = { points: raw, enabled: base.enabled };
    } else if (raw && typeof raw === "object") {
      const rule = raw as Record<string, unknown>;
      out[reason] = {
        points: typeof rule.points === "number" && Number.isFinite(rule.points) ? rule.points : base.points,
        enabled: typeof rule.enabled === "boolean" ? rule.enabled : base.enabled,
      };
    } else {
      out[reason] = { ...base };
    }
  }
  return out;
}

export function mergeBadgeRules(stored: unknown): BadgeRule[] {
  if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_BADGES.map((badge) => ({ ...badge }));
  const parsed = z.array(badgeSchema).safeParse(stored);
  if (!parsed.success) return DEFAULT_BADGES.map((badge) => ({ ...badge }));
  return parsed.data.map((badge) => ({ ...badge })).sort((a, b) => a.threshold - b.threshold);
}

export async function getSettings(workspaceId: string): Promise<EngagementSettingsView> {
  const row = await prisma.engagementSettings.findUnique({ where: { workspaceId } });
  return { pointsRules: mergePointsRules(row?.pointsRules), badgeRules: mergeBadgeRules(row?.badgeRules) };
}

export async function saveSettings(workspaceId: string, input: unknown): Promise<EngagementSettingsView> {
  const parsed = settingsInputSchema.safeParse(input);
  if (!parsed.success) throw unprocessable(firstIssue(parsed.error));

  const pointsRules: Record<string, PointsRule> = {};
  for (const [reason, rule] of Object.entries(parsed.data.pointsRules)) {
    if (!(POINT_REASONS as readonly string[]).includes(reason)) throw unprocessable(`Noma'lum ball turi: ${reason}`);
    const base = DEFAULT_POINTS_RULES[reason as PointReason];
    pointsRules[reason] = { points: rule.points, enabled: rule.enabled ?? base.enabled };
  }

  const keys = new Set<string>();
  for (const badge of parsed.data.badgeRules) {
    if (keys.has(badge.key)) throw unprocessable(`Nishon kaliti takrorlangan: ${badge.key}`);
    keys.add(badge.key);
  }

  const json = { pointsRules: JSON.parse(JSON.stringify(pointsRules)), badgeRules: JSON.parse(JSON.stringify(parsed.data.badgeRules)) };
  await prisma.engagementSettings.upsert({
    where: { workspaceId },
    create: { workspaceId, ...json },
    update: json,
  });
  return getSettings(workspaceId);
}
