/**
 * ETAP 10 - monitoring alerts (TZ 65), per workspace.
 *
 * Rules are pure thresholds over a small `AlertInputs` snapshot, so they are
 * easy to test; `runAlertsForWorkspace` loads the snapshot, evaluates, and
 * delivers through `alertWorkspace` (Telegram + owner email). A rule alerts at
 * most once per 6 hours: the last alert time lives in AnalyticsAlertState (DB,
 * not a Redis TTL, so a Redis flush does not re-alert). Each loader is
 * isolated; an unknown input (null) never fires its rule.
 */

import { prisma } from "@/lib/db/client";
import { loadQueueStats } from "@/lib/foundation/queue-stats";
import { withTimeout } from "@/lib/foundation/time";
import { getWorkerHealth } from "@/lib/ops/worker-health";
import { alertWorkspace } from "@/lib/telegram/notify";
import { loadLlmRate, loadMetaSendRate, loadWebhookDelay } from "./kpi";
import { activeWorkspaceIds } from "./rollup";

export const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;
const WINDOW_MS = 15 * 60_000;

export const ALERT_THRESHOLDS = {
  workerStaleMs: 2 * 60_000,
  metaErrorRate: 0.2,
  metaMinAttempts: 10,
  dmQueueEtaMinutes: 60,
  webhookDelayMaxMs: 5 * 60_000,
  llmFailureRate: 0.3,
  llmMinCalls: 5,
} as const;

export interface AlertInputs {
  /** null = unknown (Redis did not answer). */
  workerDown: boolean | null;
  workerAgeMs: number | null;
  metaAttempts: number | null;
  metaFailures: number | null;
  dmQueueEtaMinutes: number | null;
  webhookDelayMaxMs: number | null;
  llmCalls: number | null;
  llmFailures: number | null;
}

export type AlertRuleId = "worker_down" | "meta_error_rate" | "dm_queue_eta" | "webhook_delay" | "llm_failure_rate";

export interface AlertRule {
  id: AlertRuleId;
  label: string;
  /** The threshold in words, for the rules list on the KPI tab. */
  threshold: string;
  /** Detail line when firing; null when the rule does not fire (or its input is unknown). */
  evaluate(inputs: AlertInputs): string | null;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export const ALERT_RULES: AlertRule[] = [
  {
    id: "worker_down",
    label: "Worker ishlamayapti",
    threshold: "Heartbeat 2 daqiqadan ortiq yangilanmagan",
    evaluate: (i) => (i.workerDown ? "Worker 2 daqiqadan beri signal yubormayapti — DM'lar yuborilmayapti." : null),
  },
  {
    id: "meta_error_rate",
    label: "Meta xatolari ko'p",
    threshold: "Oxirgi 15 daqiqada xato > 20% (kamida 10 urinish)",
    evaluate: (i) => {
      if (i.metaAttempts === null || i.metaFailures === null || i.metaAttempts < ALERT_THRESHOLDS.metaMinAttempts) return null;
      const rate = i.metaFailures / i.metaAttempts;
      return rate > ALERT_THRESHOLDS.metaErrorRate ? `Oxirgi 15 daqiqada ${i.metaAttempts} urinishdan ${i.metaFailures} tasi xato (${pct(rate)}).` : null;
    },
  },
  {
    id: "dm_queue_eta",
    label: "DM navbati uzoq",
    threshold: "Navbatni tugatish taxminan 60 daqiqadan ortiq",
    evaluate: (i) =>
      i.dmQueueEtaMinutes !== null && i.dmQueueEtaMinutes > ALERT_THRESHOLDS.dmQueueEtaMinutes
        ? `DM navbatini tugatish taxminan ${i.dmQueueEtaMinutes} daqiqa oladi.`
        : null,
  },
  {
    id: "webhook_delay",
    label: "Webhook kechikmoqda",
    threshold: "Eng katta kechikish 5 daqiqadan ortiq",
    evaluate: (i) =>
      i.webhookDelayMaxMs !== null && i.webhookDelayMaxMs > ALERT_THRESHOLDS.webhookDelayMaxMs
        ? `Webhook hodisalari ${Math.round(i.webhookDelayMaxMs / 60_000)} daqiqagacha kechikib kelgan.`
        : null,
  },
  {
    id: "llm_failure_rate",
    label: "AI chaqiruvlari xato",
    threshold: "Oxirgi 15 daqiqada xato > 30% (kamida 5 chaqiruv)",
    evaluate: (i) => {
      if (i.llmCalls === null || i.llmFailures === null || i.llmCalls < ALERT_THRESHOLDS.llmMinCalls) return null;
      const rate = i.llmFailures / i.llmCalls;
      return rate > ALERT_THRESHOLDS.llmFailureRate ? `Oxirgi 15 daqiqada ${i.llmCalls} AI chaqiruvdan ${i.llmFailures} tasi xato (${pct(rate)}).` : null;
    },
  },
];

export interface FiringAlert {
  rule: AlertRule;
  detail: string;
}

/** Pure: the rules that fire for this snapshot. */
export function evaluateAlertRules(inputs: AlertInputs): FiringAlert[] {
  const firing: FiringAlert[] = [];
  for (const rule of ALERT_RULES) {
    const detail = rule.evaluate(inputs);
    if (detail) firing.push({ rule, detail });
  }
  return firing;
}

// ─── Loading ─────────────────────────────────────────────────────────────────

export interface AlertDeps {
  loadInputs?: (workspaceId: string, now: Date) => Promise<AlertInputs>;
  notify?: (workspaceId: string, subject: string, html: string, text: string) => Promise<void>;
}

async function soft<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function loadAlertInputs(workspaceId: string, now: Date): Promise<AlertInputs> {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [health, meta, queue, webhook, llm] = await Promise.all([
    soft(() => withTimeout(getWorkerHealth(), 2000)),
    soft(() => loadMetaSendRate(workspaceId, since)),
    soft(() => withTimeout(loadQueueStats(workspaceId, { now }), 5000)),
    soft(() => loadWebhookDelay(workspaceId, since)),
    soft(() => loadLlmRate(workspaceId, since)),
  ]);
  return {
    workerDown: health ? !health.healthy : null,
    workerAgeMs: health?.ageMs ?? null,
    metaAttempts: meta?.attempts ?? null,
    metaFailures: meta?.failures ?? null,
    dmQueueEtaMinutes: queue?.dm.etaMinutes ?? null,
    webhookDelayMaxMs: webhook?.maxMs ?? null,
    llmCalls: llm?.attempts ?? null,
    llmFailures: llm?.failures ?? null,
  };
}

export interface AlertRunResult {
  workspaceId: string;
  fired: AlertRuleId[];
  cooledDown: AlertRuleId[];
}

/** One workspace: evaluate, skip rules alerted within the cooldown, deliver the rest. */
export async function runAlertsForWorkspace(workspaceId: string, now: Date = new Date(), deps: AlertDeps = {}): Promise<AlertRunResult> {
  const inputs = await (deps.loadInputs ?? loadAlertInputs)(workspaceId, now);
  const notify = deps.notify ?? alertWorkspace;
  const result: AlertRunResult = { workspaceId, fired: [], cooledDown: [] };

  for (const { rule, detail } of evaluateAlertRules(inputs)) {
    const state = await prisma.analyticsAlertState.findUnique({ where: { workspaceId_rule: { workspaceId, rule: rule.id } } });
    if (state && now.getTime() - state.lastAlertedAt.getTime() < ALERT_COOLDOWN_MS) {
      result.cooledDown.push(rule.id);
      continue;
    }
    const subject = `SocialAuto ogohlantirish: ${rule.label}`;
    const html = `<b>${rule.label}</b>\n${detail}`;
    try {
      await notify(workspaceId, subject, html, `${rule.label}\n${detail}`);
    } catch (error) {
      console.error(`[Analytics] alert delivery failed (${rule.id}):`, error instanceof Error ? error.message : error);
    }
    await prisma.analyticsAlertState.upsert({
      where: { workspaceId_rule: { workspaceId, rule: rule.id } },
      create: { workspaceId, rule: rule.id, lastAlertedAt: now },
      update: { lastAlertedAt: now },
    });
    result.fired.push(rule.id);
  }
  return result;
}

/** Every active workspace; one failing workspace never stops the rest. */
export async function runAlertsForAll(now: Date = new Date(), deps: AlertDeps = {}): Promise<AlertRunResult[]> {
  const results: AlertRunResult[] = [];
  for (const workspaceId of await activeWorkspaceIds()) {
    try {
      results.push(await runAlertsForWorkspace(workspaceId, now, deps));
    } catch (error) {
      console.error(`[Analytics] alerts failed for ${workspaceId}:`, error instanceof Error ? error.message : error);
    }
  }
  return results;
}

/** For the KPI tab: every rule with the time it last alerted this workspace. */
export async function describeAlertRules(workspaceId: string): Promise<Array<{ id: AlertRuleId; label: string; threshold: string; lastAlertedAt: string | null }>> {
  let states: Array<{ rule: string; lastAlertedAt: Date }> = [];
  try {
    states = (await prisma.analyticsAlertState.findMany({ where: { workspaceId } })) as unknown as typeof states;
  } catch {
    states = [];
  }
  return ALERT_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    threshold: rule.threshold,
    lastAlertedAt: states.find((s) => s.rule === rule.id)?.lastAlertedAt.toISOString() ?? null,
  }));
}
