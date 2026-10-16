"use client";

/**
 * "Gamification" tab: points per reason (comment points are off by default),
 * badge thresholds, the points ledger and the leaderboard (7d / 30d / all).
 * Internal only: contacts never see points.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, Field, Pill, Toggle, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import { ENGAGEMENT_API, jsonInit, requestJson, type Meta } from "./shared";

interface PointsRule {
  points: number;
  enabled: boolean;
}
interface Badge {
  key: string;
  name: string;
  threshold: number;
}
interface SettingsView {
  pointsRules: Record<string, PointsRule>;
  badgeRules: Badge[];
}
interface LedgerItem {
  id: string;
  contactId: string;
  points: number;
  reason: string;
  occurredAt: string;
}
interface Leader {
  contactId: string;
  username: string | null;
  name: string | null;
  points: number;
  badges: Array<{ key: string; name: string }>;
}

const REASON_HINT: Record<string, string> = {
  comment: "Har bir izoh uchun. Odatda o'chiq: aks holda har komment mukofotga aylanadi.",
  giveaway_entry: "Giveaway'da qatnashganlik uchun (bir giveaway — bir marta).",
  referral_qualified: "Taklif qilingan do'st hisoblanganda.",
  purchase: "CRM'da bitim «Yutilgan» bo'lganda.",
};

const PERIODS: Array<["7d" | "30d" | "all", string]> = [
  ["7d", "7 kun"],
  ["30d", "30 kun"],
  ["all", "Hammasi"],
];

export default function GamificationTab({ meta }: { meta: Meta }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [saved, setSaved] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let live = true;
    requestJson<SettingsView>(`${ENGAGEMENT_API}/gamification/settings`).then((res) => {
      if (!live) return;
      if (res.ok) {
        setSettings(res.data);
        setSaved(JSON.stringify(res.data));
      } else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, []);

  const dirty = settings !== null && JSON.stringify(settings) !== saved;
  const canManage = meta.me.canManage;

  function setRule(reason: string, next: Partial<PointsRule>) {
    setOk(false);
    setSettings((s) => (s ? { ...s, pointsRules: { ...s.pointsRules, [reason]: { ...s.pointsRules[reason], ...next } } } : s));
  }
  function setBadge(index: number, next: Partial<Badge>) {
    setOk(false);
    setSettings((s) => (s ? { ...s, badgeRules: s.badgeRules.map((b, i) => (i === index ? { ...b, ...next } : b)) } : s));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const res = await requestJson<SettingsView>(`${ENGAGEMENT_API}/gamification/settings`, jsonInit("PUT", settings));
      if (res.ok) {
        setSettings(res.data);
        setSaved(JSON.stringify(res.data));
        setOk(true);
      } else setError(res.error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="panel space-y-4 rounded-xl p-4" aria-label="Ball qoidalari">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Ball qoidalari</h2>
            <p className="mt-1 text-xs text-muted">Ballar faqat sizga ko&apos;rinadi (CRM kontakt tarixida ham). Har bir manba bir marta hisoblanadi — qayta ishlash ikki barobar bermaydi.</p>
          </div>
          {dirty && <Pill tone="warning">Saqlanmagan o&apos;zgarishlar</Pill>}
        </div>
        {!settings ? (
          <p className="py-4 text-center text-sm text-muted">{error ? "" : "Yuklanmoqda…"}</p>
        ) : (
          <>
            <ul className="space-y-3">
              {Object.entries(settings.pointsRules).map(([reason, rule]) => (
                <li key={reason} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{meta.labels.pointReason[reason] ?? reason}</p>
                    <p className="text-xs text-muted">{REASON_HINT[reason]}</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Ball
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      className={`${inputClass} !w-20`}
                      value={rule.points}
                      disabled={!canManage}
                      onChange={(e) => setRule(reason, { points: Math.min(1000, Math.max(0, Math.floor(Number(e.target.value) || 0))) })}
                      aria-label={`${meta.labels.pointReason[reason] ?? reason}: ball`}
                    />
                  </label>
                  <Toggle on={rule.enabled} onChange={(enabled) => canManage && setRule(reason, { enabled })} label={`${meta.labels.pointReason[reason] ?? reason}: yoqilgan`} />
                </li>
              ))}
            </ul>

            <div className="space-y-2">
              <p className="text-sm font-semibold text-foreground">Nishonlar</p>
              <p className="text-xs text-muted">Kontakt umumiy ball chegarasiga yetganda nishon oladi.</p>
              <ul className="space-y-2">
                {settings.badgeRules.map((b, i) => (
                  <li key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_7rem_auto] sm:items-end">
                    <Field label="Nomi">
                      <input className={inputClass} value={b.name} maxLength={30} disabled={!canManage} onChange={(e) => setBadge(i, { name: e.target.value })} />
                    </Field>
                    <Field label="Kalit (lotin)">
                      <input className={inputClass} value={b.key} maxLength={30} disabled={!canManage} onChange={(e) => setBadge(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
                    </Field>
                    <Field label="Chegara (ball)">
                      <input type="number" min={1} className={inputClass} value={b.threshold} disabled={!canManage} onChange={(e) => setBadge(i, { threshold: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                    </Field>
                    {canManage && (
                      <button type="button" className={secondaryButton} onClick={() => setSettings((s) => (s ? { ...s, badgeRules: s.badgeRules.filter((_, j) => j !== i) } : s))} aria-label={`${b.name} nishonini olib tashlash`}>
                        Olib tashlash
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canManage && settings.badgeRules.length < 20 && (
                <button type="button" className={secondaryButton} onClick={() => setSettings((s) => (s ? { ...s, badgeRules: [...s.badgeRules, { key: `badge${s.badgeRules.length + 1}`, name: "Yangi nishon", threshold: 100 }] } : s))}>
                  Nishon qo&apos;shish
                </button>
              )}
            </div>
            {error && <Notice tone="error">{error}</Notice>}
            {ok && <Notice tone="info">Saqlandi.</Notice>}
            <button type="button" className={primaryButton} disabled={saving || !canManage || !dirty} onClick={() => void save()}>
              {saving ? "Saqlanmoqda…" : "Saqlash"}
            </button>
            {!canManage && <p className="text-xs text-muted">O&apos;zgartirish uchun Menejer yoki undan yuqori rol kerak.</p>}
          </>
        )}
      </section>

      <LeaderboardPanel />
      <LedgerPanel reasons={meta.labels.pointReason} />
    </div>
  );
}

function LeaderboardPanel() {
  const [period, setPeriod] = useState<"7d" | "30d" | "all">("30d");
  const [rows, setRows] = useState<Leader[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const mine = ++seq.current;
    requestJson<{ rows: Leader[] }>(`${ENGAGEMENT_API}/gamification/leaderboard?period=${period}&limit=20`).then((res) => {
      if (mine !== seq.current) return;
      if (res.ok) {
        setRows(res.data.rows);
        setError(null);
      } else setError(res.error);
    });
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [period]);

  return (
    <section className="panel space-y-3 rounded-xl p-4" aria-label="Reyting">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">Reyting</h2>
        <div className="flex gap-1" role="group" aria-label="Davr">
          {PERIODS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={period === key}
              onClick={() => {
                setRows(null);
                setPeriod(key);
              }}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${period === key ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {rows === null ? (
        <p className="py-4 text-center text-sm text-muted">{error ? "" : "Yuklanmoqda…"}</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Bu davrda ball yo'q" body="Ballar giveaway, taklif va xaridlar uchun yig'iladi." />
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r, i) => (
            <li key={r.contactId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="w-6 text-center font-bold tabular-nums text-muted">{i + 1}</span>
              <Link href={`/developer/crm?tab=contacts&contact=${r.contactId}`} className="min-w-0 break-all font-medium text-foreground hover:underline">
                {r.username ? `@${r.username}` : (r.name ?? r.contactId)}
              </Link>
              <span className="flex flex-wrap gap-1">
                {r.badges.map((b) => (
                  <Pill key={b.key} tone="success">
                    {b.name}
                  </Pill>
                ))}
              </span>
              <span className="ml-auto font-bold tabular-nums text-foreground">{r.points}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LedgerPanel({ reasons }: { reasons: Record<string, string> }) {
  const [items, setItems] = useState<LedgerItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (after: string | null) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "30" });
      if (after) params.set("cursor", after);
      const res = await requestJson<{ items: LedgerItem[]; nextCursor: string | null }>(`${ENGAGEMENT_API}/gamification/ledger?${params}`);
      if (mine !== seq.current) return;
      if (res.ok) {
        setItems((prev) => (after && prev ? [...prev, ...res.data.items] : res.data.items));
        setCursor(res.data.nextCursor);
        setError(null);
      } else setError(res.error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load(null);
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  return (
    <section className="panel space-y-3 rounded-xl p-4" aria-label="Ball jurnali">
      <h2 className="text-sm font-semibold text-foreground">Ball jurnali</h2>
      {error && <Notice tone="error">{error}</Notice>}
      {items === null ? (
        <p className="py-4 text-center text-sm text-muted">{error ? "" : "Yuklanmoqda…"}</p>
      ) : items.length === 0 ? (
        <EmptyState title="Jurnal bo'sh" />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((it) => (
            <li key={it.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="font-bold tabular-nums text-foreground">{it.points > 0 ? `+${it.points}` : it.points}</span>
              <span className="text-foreground">{reasons[it.reason] ?? it.reason}</span>
              <Link href={`/developer/crm?tab=contacts&contact=${it.contactId}`} className="text-xs text-accent hover:underline">
                Kontakt
              </Link>
              <span className="ml-auto text-xs text-muted">{formatDateTime(it.occurredAt)}</span>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load(cursor)}>
          {loading ? "Yuklanmoqda…" : "Yana yuklash"}
        </button>
      )}
    </section>
  );
}
