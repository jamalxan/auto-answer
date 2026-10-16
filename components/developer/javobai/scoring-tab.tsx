"use client";

/**
 * Lead scoring (TZ 24): points per signal, the Warm / Hot / Very hot bands,
 * the optional "handoff at score" and "lost after N days", and a calculator
 * that shows what a conversation with the ticked signals would score.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Field, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Notice } from "@/components/developer/comments/parts";
import { bandForScore, JAVOBAI_API, jsonInit, requestJson, type ScoreSignal, type ScoringConfig } from "./shared";

interface ScoringResponse {
  config: ScoringConfig;
  isDefault: boolean;
  signals: ScoreSignal[];
  updatedAt: string | null;
}

function ThresholdInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={1}
          max={100}
          value={value}
          aria-label={`${label} slayder`}
          className="min-w-0 flex-1"
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <input
          type="number"
          min={1}
          max={100}
          value={value}
          aria-label={label}
          className={`${inputClass} w-20`}
          onChange={(e) => onChange(Number(e.target.value) || 1)}
        />
      </div>
    </Field>
  );
}

export default function ScoringTab() {
  const [data, setData] = useState<ScoringResponse | null>(null);
  const [config, setConfig] = useState<ScoringConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    const res = await requestJson<ScoringResponse>(`${JAVOBAI_API}/scoring`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setData(res.data);
      setConfig(res.data.config);
    } else setError(res.error);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  if (error && !data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
        <span>{error}</span>
        <button type="button" className={secondaryButton} onClick={() => void load()}>
          Qayta urinish
        </button>
      </div>
    );
  }
  if (!data || !config) return <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>;

  const pointsFor = (key: string) => config.rules.find((r) => r.signal === key)?.points;
  const setPoints = (key: string, points: number) => {
    setSaved(false);
    setConfig((c) =>
      c
        ? {
            ...c,
            rules: c.rules.some((r) => r.signal === key)
              ? c.rules.map((r) => (r.signal === key ? { ...r, points } : r))
              : [...c.rules, { signal: key, points }],
          }
        : c
    );
  };
  const setThreshold = (key: keyof ScoringConfig["thresholds"], value: number) => {
    setSaved(false);
    setConfig((c) => (c ? { ...c, thresholds: { ...c.thresholds, [key]: value } } : c));
  };
  const t = config.thresholds;
  const orderOk = t.warm < t.hot && t.hot < t.veryHot;

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const res = await requestJson<{ config: ScoringConfig }>(`${JAVOBAI_API}/scoring`, jsonInit("PUT", config));
      if (res.ok) {
        setSaved(true);
        void load();
      } else setError(res.error);
    } finally {
      setSaving(false);
    }
  }

  const example = ticked.reduce((sum, key) => sum + (pointsFor(key) ?? 0), 0);
  const exampleScore = Math.max(0, Math.min(100, example));
  const band = bandForScore(exampleScore, t);

  return (
    <div className="space-y-4">
      {data.isDefault && (
        <Notice tone="info">Hozir standart qiymatlar ishlayapti (workspace uchun hali saqlanmagan). O&apos;zgartirib &quot;Saqlash&quot; ni bosing.</Notice>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="panel space-y-3 rounded-xl p-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Signallar va ballar</h2>
            <p className="mt-1 text-xs text-muted">
              Har bir signal bitta lead siklida bir marta hisoblanadi. Ballarni kod aniqlaydi — AI hech qachon ball bermaydi.
            </p>
          </div>
          <ul className="divide-y divide-border">
            {data.signals.map((signal) => (
              <li key={signal.key} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{signal.label}</p>
                  <p className="label-mono text-[10px] text-muted">
                    {signal.key} · odatda {signal.defaultPoints > 0 ? `+${signal.defaultPoints}` : signal.defaultPoints}
                  </p>
                </div>
                <input
                  type="number"
                  min={-100}
                  max={100}
                  className={`${inputClass} w-20 text-right`}
                  value={pointsFor(signal.key) ?? signal.defaultPoints}
                  aria-label={`${signal.label} balli`}
                  onChange={(e) => setPoints(signal.key, Number(e.target.value) || 0)}
                />
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-4">
          <section className="panel space-y-3 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-foreground">Chegaralar</h2>
            <ThresholdInput label="Warm — shu baldan" value={t.warm} onChange={(v) => setThreshold("warm", v)} />
            <ThresholdInput label="Hot — shu baldan" value={t.hot} onChange={(v) => setThreshold("hot", v)} />
            <ThresholdInput label="Very hot — shu baldan" value={t.veryHot} onChange={(v) => setThreshold("veryHot", v)} />
            {!orderOk && <Notice tone="error">Chegaralar o&apos;sib borsin: Warm &lt; Hot &lt; Very hot (masalan 30 &lt; 60 &lt; 80).</Notice>}
            <p className="text-xs text-muted">
              0–{t.warm - 1} Cold · {t.warm}–{t.hot - 1} Warm · {t.hot}–{t.veryHot - 1} Hot · {t.veryHot}+ Very hot. &quot;Very hot&quot;
              diapazon, status emas.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Operatorga topshirish bali" hint="Bo'sh = faqat intent / qoidalar bo'yicha.">
                <input
                  type="number"
                  min={1}
                  max={100}
                  className={inputClass}
                  value={config.handoffAtScore ?? ""}
                  placeholder="masalan 80"
                  aria-label="Operatorga topshirish bali"
                  onChange={(e) => {
                    setSaved(false);
                    setConfig((c) => (c ? { ...c, handoffAtScore: e.target.value === "" ? null : Number(e.target.value) } : c));
                  }}
                />
              </Field>
              <Field label="Yo'qotilgan deb belgilash (kun)" hint="Warm/Hot mijoz shuncha kun jim bo'lsa → Lost. Bo'sh = hech qachon.">
                <input
                  type="number"
                  min={1}
                  max={365}
                  className={inputClass}
                  value={config.lostAfterDays ?? ""}
                  placeholder="masalan 14"
                  aria-label="Yo'qotilgan deb belgilash kunlari"
                  onChange={(e) => {
                    setSaved(false);
                    setConfig((c) => (c ? { ...c, lostAfterDays: e.target.value === "" ? null : Number(e.target.value) } : c));
                  }}
                />
              </Field>
            </div>
          </section>

          <section className="panel space-y-3 rounded-xl p-4">
            <h2 className="text-sm font-semibold text-foreground">Kalkulyator</h2>
            <p className="text-xs text-muted">Suhbatda qaysi signallar bo&apos;lsa — ball qancha bo&apos;ladi.</p>
            <div className="flex flex-wrap gap-1.5">
              {data.signals.map((signal) => {
                const on = ticked.includes(signal.key);
                return (
                  <button
                    key={signal.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setTicked((list) => (on ? list.filter((k) => k !== signal.key) : [...list, signal.key]))}
                    className={`rounded-full border px-2.5 py-1 text-xs ${
                      on ? "border-accent bg-accent/10 text-foreground" : "border-border text-muted hover:text-foreground"
                    }`}
                  >
                    {signal.label} ({(pointsFor(signal.key) ?? signal.defaultPoints) > 0 ? "+" : ""}
                    {pointsFor(signal.key) ?? signal.defaultPoints})
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-bold text-foreground">{exampleScore}</span>
              <Pill tone={band.tone}>{band.label}</Pill>
              {config.handoffAtScore !== null && exampleScore >= config.handoffAtScore && (
                <Pill tone="warning">operatorga topshiriladi</Pill>
              )}
              {example !== exampleScore && <span className="text-xs text-muted">(0–100 oralig&apos;ida ushlanadi)</span>}
            </div>
          </section>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primaryButton} disabled={saving || !orderOk} onClick={() => void save()}>
          {saving ? "Saqlanmoqda…" : "Saqlash"}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            setSaved(false);
            setConfig({
              rules: data.signals.map((s) => ({ signal: s.key, points: s.defaultPoints })),
              thresholds: { warm: 30, hot: 60, veryHot: 80 },
              handoffAtScore: null,
              lostAfterDays: null,
            });
          }}
        >
          Standart qiymatlar
        </button>
        {saved && <span className="text-xs text-success">Saqlandi</span>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
