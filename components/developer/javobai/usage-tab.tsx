"use client";

/**
 * This month's LLM spend per kind (JavobAI kinds next to production's) and
 * the workspace budget (soft = alert, hard = stop).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Field, formatDateTime, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import { formatUsd, JAVOBAI_API, jsonInit, requestJson, type LeadRow, type UsageResponse, TEMPERATURE_TEXT } from "./shared";

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3">
      <p className="label-mono break-words text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 break-words text-xl font-bold leading-tight ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function BudgetForm({ usage, onSaved }: { usage: UsageResponse; onSaved: () => void }) {
  const [soft, setSoft] = useState(usage.budget ? String(usage.budget.monthlyUsdSoft) : "10");
  const [hard, setHard] = useState(usage.budget?.monthlyUsdHard === null || !usage.budget ? "" : String(usage.budget.monthlyUsdHard));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await requestJson(
        `${JAVOBAI_API}/budget`,
        jsonInit("PUT", { monthlyUsdSoft: Number(soft), monthlyUsdHard: hard.trim() === "" ? null : Number(hard) })
      );
      if (res.ok) {
        setSaved(true);
        onSaved();
      } else setError(res.error);
    } finally {
      setSaving(false);
    }
  }

  const used = usage.totalUsd;
  const softPct = usage.budget ? usage.budget.pct / 100 : null;

  return (
    <section className="panel space-y-3 rounded-xl p-4">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Oylik byudjet (USD)</h2>
        <p className="mt-1 text-xs text-muted">
          Yumshoq limit — 50 / 80 / 100 % da ogohlantirish. Qattiq limit — oshganda JavobAI shablon javobga o&apos;tadi va operatorga
          topshiradi.
        </p>
      </div>
      {usage.budget?.status === "hard_exceeded" && (
        <Notice tone="error">
          Qattiq limit oshdi — JavobAI model chaqirmaydi, shablon javob beradi va operatorga topshiradi. Limitni oshiring yoki
          keyingi oyni kuting.
        </Notice>
      )}
      {usage.budget?.status === "soft_exceeded" && (
        <Notice tone="warning">Yumshoq limit oshdi — ogohlantirish yuborilgan, JavobAI ishlashda davom etmoqda.</Notice>
      )}
      {usage.budget && softPct !== null && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span>
              {formatUsd(used)} / {formatUsd(usage.budget.monthlyUsdSoft)} ({Math.round(softPct * 100)}%)
            </span>
            <span className="flex gap-2">
              {usage.budget.alerted50At && <Pill tone="warning">50% · {formatDateTime(usage.budget.alerted50At)}</Pill>}
              {usage.budget.alerted80At && <Pill tone="warning">80% · {formatDateTime(usage.budget.alerted80At)}</Pill>}
              {usage.budget.alerted100At && <Pill tone="error">100% · {formatDateTime(usage.budget.alerted100At)}</Pill>}
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-surface-hover" role="progressbar" aria-valuenow={Math.round(softPct * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={`h-full rounded-full ${softPct >= 1 ? "bg-error" : softPct >= 0.8 ? "bg-warning" : "bg-accent"}`}
              style={{ width: `${Math.min(100, softPct * 100)}%` }}
            />
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Yumshoq limit ($)" hint="Masalan 10">
          <input type="number" min={0.01} step="0.5" className={inputClass} value={soft} onChange={(e) => { setSaved(false); setSoft(e.target.value); }} />
        </Field>
        <Field label="Qattiq limit ($)" hint="Bo'sh = to'xtatmaydi">
          <input type="number" min={0.01} step="0.5" className={inputClass} value={hard} placeholder="—" onChange={(e) => { setSaved(false); setHard(e.target.value); }} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={saving || !soft} onClick={() => void save()}>
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        {saved && <span className="text-xs text-success">Saqlandi</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

export default function UsageTab() {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const [u, l] = await Promise.all([
      requestJson<UsageResponse>(`${JAVOBAI_API}/usage`),
      requestJson<{ leads: LeadRow[] }>(`${JAVOBAI_API}/leads`),
    ]);
    if (mine !== seq.current) return;
    if (u.ok) setUsage(u.data);
    else setError(u.error);
    if (l.ok) setLeads(l.data.leads);
    else setError(l.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  if (error && !usage) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
        <span>{error}</span>
        <button type="button" className={secondaryButton} onClick={() => void load()}>
          Qayta urinish
        </button>
      </div>
    );
  }
  if (!usage) return <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>;

  const calls = usage.calls;
  const since = new Date(usage.since);

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Shu oy, jami" value={formatUsd(usage.totalUsd)} />
        <Stat label="JavobAI ulushi" value={formatUsd(usage.javobaiUsd)} tone={usage.javobaiUsd ? "text-warning" : undefined} />
        <Stat label="LLM chaqiruvlar" value={calls} />
        <Stat label="Hisob boshi" value={since.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" })} />
      </div>

      <section className="panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground">Turlar bo&apos;yicha</h2>
        <p className="mt-1 text-xs text-muted">
          <code>javobai_*</code> — JavobAI (SHADOW ham shu yerda; u oylik AI suhbat kvotasiga kirmaydi). Qolganlari — production
          assistent.
        </p>
        {usage.kinds.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Shu oyda LLM chaqiruvi bo&apos;lmagan.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="label-mono text-left text-[10px] text-muted">
                  <th className="py-1 pr-3 font-semibold">Turi</th>
                  <th className="py-1 pr-3 text-right font-semibold">Chaqiruv</th>
                  <th className="py-1 pr-3 text-right font-semibold">Token (in / out)</th>
                  <th className="py-1 text-right font-semibold">USD</th>
                </tr>
              </thead>
              <tbody>
                {usage.kinds.map((k) => (
                  <tr key={k.kind} className="border-t border-border">
                    <td className="py-1.5 pr-3">
                      <span className="text-foreground">{k.label}</span>{" "}
                      <span className={`label-mono text-[10px] ${k.javobai ? "text-accent" : "text-muted"}`}>{k.kind}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-foreground">
                      {k.calls}
                      {k.failedCalls > 0 && <span className="text-error"> ({k.failedCalls} xato)</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-muted">
                      {k.inputTokens} / {k.outputTokens}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-foreground">{formatUsd(k.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <BudgetForm key={usage.budget?.monthlyUsdSoft ?? "none"} usage={usage} onSaved={() => void load()} />

      <section className="panel rounded-xl p-4">
        <h2 className="text-sm font-semibold text-foreground">JavobAI leadlari</h2>
        <p className="mt-1 text-xs text-muted">Ball va harorat bilan yaratilgan oxirgi leadlar (Telegram / CRM&apos;ga ham ketgan).</p>
        {leads === null ? (
          <p className="mt-3 text-sm text-muted">Yuklanmoqda…</p>
        ) : leads.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Hali JavobAI lead yaratmagan.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {leads.map((lead) => {
              const t = lead.aiInsight ? TEMPERATURE_TEXT[lead.aiInsight.temperature] : null;
              return (
                <li key={lead.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                  <span className="font-medium text-foreground">{lead.igUsername ? `@${lead.igUsername}` : lead.name || lead.igUserId}</span>
                  {lead.isTest && <Pill tone="warning">🧪 TEST</Pill>}
                  {t && lead.aiInsight && (
                    <Pill tone={t.tone}>
                      {t.emoji} {t.label} {lead.aiInsight.score}
                    </Pill>
                  )}
                  <span className="text-xs text-muted">
                    @{lead.accountUsername} · {lead.phoneE164 ?? "telefon yo'q"} · {lead.productInterest ?? "—"} · {lead.status} ·{" "}
                    {formatDateTime(lead.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
