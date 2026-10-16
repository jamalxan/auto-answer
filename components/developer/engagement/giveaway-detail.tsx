"use client";

/**
 * One giveaway: status stepper DRAFT -> ACTIVE -> CLOSED -> DRAWN, live
 * participants, backfill progress, close-and-commit, the draw and winner
 * notification, exports. Refreshes itself every 15 s while collecting.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Pill, formatDateTime, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import DrawPanel from "./draw-panel";
import EntriesTable from "./entries-table";
import GiveawayWizard from "./giveaway-wizard";
import {
  ENGAGEMENT_API,
  GIVEAWAY_STATUS,
  VERIFIABILITY_TONE,
  requestJson,
  type GiveawayDetail,
  type GiveawayStatus,
  type Meta,
} from "./shared";

const STEPS: Array<[GiveawayStatus, string]> = [
  ["DRAFT", "Qoralama"],
  ["ACTIVE", "Faol"],
  ["CLOSED", "Yopilgan"],
  ["DRAWN", "Qur'a"],
];

const NEXT_STEP: Record<GiveawayStatus, string> = {
  DRAFT: "Qoidalarni tekshiring va «Faollashtirish»ni bosing — shundan keyin izohlar yig'ila boshlaydi va qoidalarni o'zgartirib bo'lmaydi.",
  ACTIVE: "Izohlar yig'ilmoqda. Davr tugagach «Yopish va commit»ni bosing: yashirin son (seed) imzosi e'lon qilinadi.",
  CLOSED: "Yopildi va commit qilindi. Tekshirilmoqda holatidagilarni hal qiling, so'ng «Qur'a tashlash».",
  DRAWN: "Qur'a tashlandi. Natijani tekshiring, tasdiqlang va g'oliblarga xabar yuboring.",
  ARCHIVED: "Arxivlangan: faqat ko'rish va eksport.",
};

function Stepper({ status }: { status: GiveawayStatus }) {
  const index = status === "ARCHIVED" ? STEPS.length : STEPS.findIndex(([key]) => key === status);
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Giveaway bosqichlari">
      {STEPS.map(([key, label], i) => (
        <li key={key} className="flex items-center gap-2" aria-current={i === index ? "step" : undefined}>
          <span
            className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ${
              i < index ? "bg-success/20 text-success" : i === index ? "bg-accent text-background" : "bg-border text-muted"
            }`}
          >
            {i < index ? "✓" : i + 1}
          </span>
          <span className={i === index ? "font-semibold text-foreground" : "text-muted"}>{label}</span>
          {i < STEPS.length - 1 && <span className="text-border-hover" aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}

export default function GiveawayDetailView({ meta, giveawayId, onBack }: { meta: Meta; giveawayId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<GiveawayDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const seq = useRef(0);

  const load = useCallback(
    async (quiet = false) => {
      const mine = ++seq.current;
      if (!quiet) setLoading(true);
      try {
        const res = await requestJson<GiveawayDetail>(`${ENGAGEMENT_API}/giveaways/${giveawayId}`);
        if (mine !== seq.current) return;
        if (res.ok) {
          setDetail(res.data);
          setFailure(null);
        } else setFailure(res.error);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [giveawayId]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
    const counter = seq;
    return () => {
      counter.current++;
    };
  }, [load]);

  const status = detail?.giveaway.status;
  const backfillRunning = detail?.backfill.status === "RUNNING" || detail?.backfill.status === "QUEUED";
  useEffect(() => {
    if (status !== "ACTIVE" && !backfillRunning) return;
    const timer = setInterval(() => {
      void load(true);
      setRefreshKey((k) => k + 1);
    }, 15_000);
    return () => clearInterval(timer);
  }, [status, backfillRunning, load]);

  const reloadAll = useCallback(() => {
    void load(true);
    setRefreshKey((k) => k + 1);
  }, [load]);

  const runAction = useCallback(
    async (path: string, key: string): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
      setBusy(key);
      setActionError(null);
      setMessage(null);
      try {
        const res = await requestJson<unknown>(`${ENGAGEMENT_API}/giveaways/${giveawayId}/${path}`, { method: "POST" });
        if (!res.ok) setActionError(res.error);
        reloadAll();
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
      } finally {
        setBusy(null);
      }
    },
    [giveawayId, reloadAll]
  );

  async function remove() {
    setBusy("delete");
    setActionError(null);
    try {
      const res = await requestJson(`${ENGAGEMENT_API}/giveaways/${giveawayId}`, { method: "DELETE" });
      if (res.ok) onBack();
      else setActionError(res.error);
    } finally {
      setBusy(null);
    }
  }

  async function resolveAll() {
    const res = await runAction("resolve-unverifiable", "resolve");
    if (res.ok) setMessage(`${(res.data as { count?: number }).count ?? 0} ta ishtirokchi qabul qilindi.`);
  }

  if (!detail) {
    return (
      <div className="space-y-3">
        <button type="button" className={secondaryButton} onClick={onBack}>
          ← Ro&apos;yxatga
        </button>
        {failure ? (
          <Notice tone="error">
            {failure}{" "}
            <button type="button" className="underline" onClick={() => void load()}>
              Qayta urinish
            </button>
          </Notice>
        ) : (
          <p className="py-10 text-center text-sm text-muted">{loading ? "Yuklanmoqda…" : ""}</p>
        )}
      </div>
    );
  }

  const g = detail.giveaway;
  const canManage = meta.me.canManage;
  const canExport = meta.me.canExport;

  if (editing) {
    return (
      <GiveawayWizard
        meta={meta}
        giveaway={g}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          reloadAll();
        }}
      />
    );
  }

  const st = GIVEAWAY_STATUS[g.status];
  const pending = detail.counts.PENDING_CHECK ?? 0;
  const followRule = g.rules.follow.required;
  const exportBase = `${ENGAGEMENT_API}/giveaways/${g.id}`;
  const verifiability = detail.verifiability;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <button type="button" className="text-xs text-muted hover:text-foreground" onClick={onBack}>
            ← Giveaway&apos;lar
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-lg font-bold text-foreground">{g.name}</h2>
            <Pill tone={st.tone}>{st.label}</Pill>
          </div>
          <p className="text-xs text-muted">
            {g.accountUsername ? `@${g.accountUsername} · ` : ""}
            {formatDateTime(g.windowStart)} – {formatDateTime(g.windowEnd)} · {g.winnersCount} g&apos;olib
            {g.backupCount > 0 ? ` + ${g.backupCount} zaxira` : ""}
            {g.confirmCampaignId
              ? ` · Tasdiqlovchi kampaniya: ${meta.campaigns.find((c) => c.id === g.confirmCampaignId)?.name ?? g.confirmCampaignId} (yorliq — DM'ni kampaniya yuboradi)`
              : ""}
            {g.mediaMeta?.permalink && (
              <>
                {" · "}
                <a href={g.mediaMeta.permalink} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                  Postni ochish
                </a>
              </>
            )}
          </p>
        </div>
        <button type="button" className={secondaryButton} onClick={reloadAll} disabled={loading}>
          Yangilash
        </button>
      </div>

      <Stepper status={g.status} />
      <Notice tone="info">{NEXT_STEP[g.status]}</Notice>
      {failure && <Notice tone="error">{failure}</Notice>}
      {actionError && <Notice tone="error">{actionError}</Notice>}
      {message && <Notice tone="info">{message}</Notice>}

      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          ["Ishtirokchi", g.entriesCount],
          ["Qabul qilingan", g.eligibleCount],
          ["Tekshirilmoqda", pending],
        ].map(([label, value]) => (
          <div key={label as string} className="panel rounded-xl p-3">
            <p className="text-xl font-bold tabular-nums text-foreground">{value}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {g.status === "DRAFT" && (
            <>
              <button type="button" className={secondaryButton} onClick={() => setEditing(true)}>
                Tahrirlash
              </button>
              <ConfirmButton
                label="Faollashtirish"
                question="Faollashtirilsinmi? Qoidalarni keyin o'zgartirib bo'lmaydi."
                confirmLabel="Ha, faollashtirish"
                busy={busy === "activate"}
                onConfirm={() => void runAction("activate", "activate")}
              />
              <ConfirmButton label="O'chirish" question="Qoralama o'chirilsinmi?" danger confirmLabel="O'chirish" busy={busy === "delete"} onConfirm={() => void remove()} />
            </>
          )}
          {g.status === "ACTIVE" && (
            <ConfirmButton
              label="Yopish va commit"
              question="Yangi izohlar qabul qilinmaydi. Yopilsinmi?"
              confirmLabel="Ha, yopish"
              busy={busy === "close"}
              onConfirm={() => void runAction("close", "close")}
            />
          )}
          {(g.status === "CLOSED" || g.status === "DRAWN") && (
            <ConfirmButton label="Arxivlash" question="Arxivlansinmi?" confirmLabel="Arxivlash" busy={busy === "archive"} onConfirm={() => void runAction("archive", "archive")} />
          )}
          {(g.status === "ACTIVE" || g.status === "CLOSED") && pending > 0 && (
            <ConfirmButton
              label="Tekshirib bo'lmaydiganlarni qabul qilish"
              question={`Tekshirilmoqda holatidagi ${pending} ta ishtirokchi qabul qilinsinmi?`}
              confirmLabel="Ha, qabul qilish"
              busy={busy === "resolve"}
              onConfirm={() => void resolveAll()}
            />
          )}
        </div>
      )}

      {g.status === "ACTIVE" && g.eligibleCount === 0 && g.entriesCount === 0 && (
        <Notice tone="info">Hali izoh kelmadi. Yangi izoh odatda bir daqiqa ichida ko&apos;rinadi; eski izohlar uchun pastdagi «Qayta skanerlash»dan foydalaning.</Notice>
      )}
      {followRule && (
        <Notice tone="warning">
          «Obuna bo&apos;lish» sharti <b>{verifiability.follow?.badge ?? "imkon qadar"}</b> tekshiriladi: Instagram ba&apos;zan javob bermaydi.{" "}
          {g.rules.follow.onUnverifiable === "HOLD"
            ? "Bunday ishtirokchilar «Tekshirilmoqda»da turadi — ularni qo'lda hal qiling yoki hammasini bir tugma bilan qabul qiling."
            : g.rules.follow.onUnverifiable === "ALLOW"
              ? "Tasdiqlanmaganlar qabul qilinadi."
              : "Tasdiqlanmaganlar chetlatiladi."}
        </Notice>
      )}

      {(g.status === "ACTIVE" || g.status === "CLOSED") && (
        <section className="panel space-y-2 rounded-xl p-4" aria-label="Eski izohlarni yuklash">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Eski izohlar</h3>
              <p className="text-xs text-muted">
                {detail.backfill.status ? `Holat: ${detail.backfill.status}` : "Hali skanerlanmagan"} · {detail.backfill.scanned} / {meta.limits.backfillCap} izoh ko&apos;rildi
              </p>
            </div>
            {canManage && g.status === "ACTIVE" && (
              <button type="button" className={secondaryButton} disabled={busy === "backfill" || backfillRunning} onClick={() => void runAction("backfill", "backfill")}>
                {busy === "backfill" || backfillRunning ? "Skanerlanmoqda…" : "Qayta skanerlash"}
              </button>
            )}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={meta.limits.backfillCap} aria-valuenow={detail.backfill.scanned}>
            <div className="h-full bg-accent" style={{ width: `${Math.min(100, (detail.backfill.scanned / meta.limits.backfillCap) * 100)}%` }} />
          </div>
          {detail.backfill.error && <Notice tone="error">{detail.backfill.error}</Notice>}
        </section>
      )}

      {(g.status === "CLOSED" || g.status === "DRAWN" || g.status === "ARCHIVED") && (
        <section className="panel space-y-3 rounded-xl p-4" aria-label="Qur'a">
          <h3 className="text-sm font-semibold text-foreground">Qur&apos;a</h3>
          <DrawPanel detail={detail} canManage={canManage} busy={busy} runAction={runAction} />
        </section>
      )}

      <section className="panel space-y-3 rounded-xl p-4" aria-label="Ishtirokchilar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Ishtirokchilar</h3>
          {canExport && g.entriesCount > 0 && (
            <div className="flex flex-wrap gap-2">
              <a className={secondaryButton} href={`${exportBase}/entries.csv`} download>
                Ishtirokchilar CSV
              </a>
              {detail.draws.filter((d) => d.status !== "VOIDED").slice(-1).map((d) => (
                <a key={d.id} className={secondaryButton} href={`${exportBase}/draws/${d.sequence}/record.csv`} download>
                  Qur&apos;a dalolatnomasi CSV
                </a>
              ))}
            </div>
          )}
        </div>
        <EntriesTable giveawayId={g.id} giveawayStatus={g.status} canManage={canManage} refreshKey={refreshKey} onChanged={() => void load(true)} />
      </section>

      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted hover:text-foreground">Qoidalar va ularni tekshirish imkoni</summary>
        <ul className="space-y-1.5 border-t border-border p-3 text-xs text-muted">
          {Object.entries(verifiability)
            .filter(([key]) => ["comment", "tagFriends", "mention", "follow"].includes(key))
            .map(([key, v]) => {
              const rule = g.rules[key as "comment" | "tagFriends" | "mention" | "follow"];
              const on = key === "comment" ? true : (rule as { required: boolean }).required;
              return (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <span className="text-foreground">{v.label}</span>
                  <Pill tone={on ? "success" : "muted"}>{on ? "Yoqilgan" : "O'chiq"}</Pill>
                  <Pill tone={VERIFIABILITY_TONE[v.verifiable]}>{v.badge}</Pill>
                </li>
              );
            })}
        </ul>
      </details>
    </div>
  );
}
