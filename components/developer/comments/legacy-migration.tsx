"use client";

/**
 * One old (production) campaign's move into the Comment 2.0 engine
 * (lib/campaigns/legacy-migration.ts): plan → shadow comparison → cutover,
 * with rollback at every step.
 */

import { useState } from "react";
import { formatDateTime, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton } from "./parts";
import { jsonInit, requestJson } from "./shared";

export interface LegacyMigrationView {
  automationId: string;
  automationName: string;
  automationActive: boolean;
  plan: { blockers: string[]; notes: string[] };
  migration: {
    id: string;
    status: "SHADOW" | "CUTOVER" | "ROLLED_BACK";
    triggerCampaignId: string;
    shadowStartedAt: string;
    cutoverAt: string | null;
    rolledBackAt: string | null;
    forcedReason: string | null;
    notes: string[];
    stats: { samples: number; agreed: number; legacyOnly: number; newOnly: number };
    daysInShadow: number;
    readyForCutover: boolean;
    disagreements: Array<{ commentText: string; legacyMatched: boolean; newMatched: boolean; createdAt: string }>;
  } | null;
}

const SHADOW_DAYS = 14;

export function LegacyMigrationPanel({ view, onChanged }: { view: LegacyMigrationView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forcing, setForcing] = useState(false);
  const [reason, setReason] = useState("");
  const m = view.migration;
  const active = m && m.status !== "ROLLED_BACK" ? m : null;

  async function call(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(url, jsonInit("POST", body));
      if (!res.ok) setError(res.error);
      else {
        setForcing(false);
        setReason("");
      }
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded-xl bg-white/[0.03] p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">Yangi dvigatelga ko&apos;chirish</span>
        {!active && view.plan.blockers.length > 0 && <Pill tone="error">Ko&apos;chirib bo&apos;lmaydi</Pill>}
        {!active && view.plan.blockers.length === 0 && <Pill tone="muted">Tayyor</Pill>}
        {active?.status === "SHADOW" && <Pill tone="warning">Kuzatuv: {active.daysInShadow}/{SHADOW_DAYS} kun</Pill>}
        {active?.status === "CUTOVER" && <Pill tone="success">Ko&apos;chirildi</Pill>}
        {m?.status === "ROLLED_BACK" && <Pill tone="muted">Qaytarilgan</Pill>}
      </div>

      {!active && view.plan.blockers.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-error">
          {view.plan.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {(active?.notes ?? view.plan.notes).length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-muted">
          {(active?.notes ?? view.plan.notes).map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {active && (
        <p className="text-muted">
          Taqqoslangan kommentlar: <b className="text-foreground">{active.stats.samples}</b> · bir xil qaror: <b className="text-foreground">{active.stats.agreed}</b> · faqat eski javob berardi:{" "}
          <b className={active.stats.legacyOnly ? "text-error" : "text-foreground"}>{active.stats.legacyOnly}</b> · faqat yangi javob berardi:{" "}
          <b className={active.stats.newOnly ? "text-error" : "text-foreground"}>{active.stats.newOnly}</b>
          {active.status === "CUTOVER" && active.cutoverAt && <> · o&apos;tkazildi {formatDateTime(active.cutoverAt)}</>}
          {active.forcedReason && <> · majburan: {active.forcedReason}</>}
        </p>
      )}
      {active && active.disagreements.length > 0 && (
        <ul className="space-y-1">
          {active.disagreements.map((d, i) => (
            <li key={i} className="rounded-lg bg-error/10 px-2 py-1">
              &quot;{d.commentText}&quot; — {d.legacyMatched ? "eski javob berardi, yangi bermaydi" : "yangi javob berardi, eski bermasdi"}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!active && view.plan.blockers.length === 0 && (
          <button type="button" className={primaryButton} disabled={busy} onClick={() => call("/api/comments/legacy", { automationId: view.automationId })}>
            {busy ? "Kuting…" : "Kuzatuvni boshlash"}
          </button>
        )}
        {active?.status === "SHADOW" && active.readyForCutover && (
          <ConfirmButton
            label="Yangi dvigatelga o'tkazish"
            question="Yangi kampaniya yoqiladi, eskisi o'chiriladi. Davom etamizmi?"
            busy={busy}
            onConfirm={() => call(`/api/comments/legacy/${active.id}`, { action: "cutover" })}
          />
        )}
        {active?.status === "SHADOW" && !active.readyForCutover && !forcing && (
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => setForcing(true)}>
            Muddatidan oldin o&apos;tkazish…
          </button>
        )}
        {active && (
          <ConfirmButton
            label={active.status === "CUTOVER" ? "Eskisiga qaytarish" : "Kuzatuvni to'xtatish"}
            question={active.status === "CUTOVER" ? "Yangi kampaniya o'chiriladi, eskisi qayta yoqiladi. Davom etamizmi?" : "Kuzatuv to'xtatiladi (eski kampaniya ishlashda davom etadi)."}
            busy={busy}
            danger
            onConfirm={() => call(`/api/comments/legacy/${active.id}`, { action: "rollback" })}
          />
        )}
      </div>

      {forcing && active && (
        <div className="flex flex-wrap items-center gap-2">
          <input className="input min-w-[16rem] flex-1 !py-1.5 text-xs" placeholder="Sabab (majburiy): masalan, kampaniya kam ishlatiladi" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          <button
            type="button"
            className={primaryButton}
            disabled={busy || reason.trim().length < 5}
            onClick={() => call(`/api/comments/legacy/${active.id}`, { action: "cutover", force: true, reason })}
          >
            O&apos;tkazish
          </button>
          <button type="button" className={secondaryButton} onClick={() => setForcing(false)}>
            Bekor
          </button>
        </div>
      )}
      {error && <p className="text-error">{error}</p>}
    </div>
  );
}
