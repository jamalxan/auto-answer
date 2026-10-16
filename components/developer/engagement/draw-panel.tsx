"use client";

/**
 * Draw section of a giveaway: the commitment (public before the draw), the
 * winners / backups of the current draw with the one-line verification string
 * and a "Tekshirish" button, confirmation, winner notification with the
 * per-channel result, and the history of all draws including VOIDED ones.
 */

import { useState } from "react";
import { Pill, formatDateTime, secondaryButton } from "@/components/developer/ui";
import { ConfirmButton, Notice } from "@/components/developer/comments/parts";
import {
  CHANNEL_LABELS,
  ENGAGEMENT_API,
  NOTIFICATION_STATUS,
  copyText,
  requestJson,
  shortHash,
  type DrawPerson,
  type DrawRow,
  type GiveawayDetail,
} from "./shared";

interface VerifyResult {
  ok: boolean;
  problems?: string[];
}

interface NotifyResult {
  telegram?: string;
  winners?: Array<{ entryId: string; username: string | null; dm: string; publicReply: string; alreadyNotified: boolean }>;
}

const DRAW_STATUS: Record<DrawRow["status"], { label: string; tone: "success" | "warning" | "muted" }> = {
  DRAWN: { label: "Tasdiq kutilmoqda", tone: "warning" },
  CONFIRMED: { label: "Tasdiqlangan", tone: "success" },
  VOIDED: { label: "Bekor qilingan", tone: "muted" },
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  return (
    <button
      type="button"
      className={secondaryButton}
      onClick={async () => {
        setState((await copyText(text)) ? "ok" : "fail");
        setTimeout(() => setState("idle"), 2000);
      }}
    >
      {state === "ok" ? "Nusxalandi" : state === "fail" ? "Nusxalab bo'lmadi" : label}
    </button>
  );
}

const personName = (p: DrawPerson) => (p.username ? `@${p.username}` : (p.igUserId ?? p.id));

function People({ title, people }: { title: string; people: DrawPerson[] }) {
  if (people.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-xs font-semibold text-muted">{title}</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground">
        {people.map((p) => (
          <li key={p.id} className="break-words">
            <b>{personName(p)}</b>
            {p.firstCommentText ? <span className="text-muted"> — {p.firstCommentText.slice(0, 80)}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function DrawPanel({
  detail,
  canManage,
  busy,
  runAction,
}: {
  detail: GiveawayDetail;
  canManage: boolean;
  busy: string | null;
  runAction: (path: string, key: string) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>;
}) {
  const { giveaway, draws, notifications } = detail;
  const current = [...draws].reverse().find((d) => d.status !== "VOIDED") ?? null;
  const [verify, setVerify] = useState<Record<number, VerifyResult | string>>({});
  const [notify, setNotify] = useState<NotifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(draw: DrawRow) {
    setError(null);
    const res = await requestJson<VerifyResult>(`${ENGAGEMENT_API}/giveaways/${giveaway.id}/draws/${draw.sequence}/verify`, { method: "POST" });
    setVerify((prev) => ({ ...prev, [draw.sequence]: res.ok ? res.data : res.error }));
  }

  async function confirm(draw: DrawRow) {
    setError(null);
    const res = await runAction(`draws/${draw.sequence}/confirm`, `confirm-${draw.sequence}`);
    if (!res.ok) setError(res.error);
  }

  async function announce(draw: DrawRow) {
    setError(null);
    const res = await runAction(`draws/${draw.sequence}/notify`, `notify-${draw.sequence}`);
    if (res.ok) setNotify(res.data as NotifyResult);
    else setError(res.error);
  }

  const verifyOf = (draw: DrawRow) => {
    const v = verify[draw.sequence];
    if (v === undefined) return null;
    if (typeof v === "string") return <Notice tone="error">{v}</Notice>;
    return v.ok ? (
      <Notice tone="info">Tekshiruv o&apos;tdi: seed commitment&apos;ga mos, g&apos;oliblar qayta hisoblashda aynan shunday chiqdi.</Notice>
    ) : (
      <Notice tone="error">Tekshiruv MOS KELMADI: {(v.problems ?? []).join("; ") || "noma'lum sabab"}</Notice>
    );
  };

  return (
    <div className="space-y-4">
      {giveaway.seedCommitment && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-semibold text-foreground">Commitment (qur&apos;adan oldin e&apos;lon qilingan)</p>
          <code className="block break-all rounded-md bg-surface-hover px-2 py-1.5 text-xs text-foreground">{giveaway.seedCommitment}</code>
          <p className="text-xs text-muted">
            Bu — qur&apos;a uchun yashirin sonning (seed) sha256 imzosi. Siz uni hozir saqlab qo&apos;ying yoki e&apos;lon qiling: qur&apos;adan keyin seed ochiladi va har kim
            sha256(seed) shu qiymatga tengligini tekshira oladi. Demak natijani qur&apos;adan keyin o&apos;zgartirib bo&apos;lmaydi.
          </p>
          <CopyButton text={giveaway.seedCommitment} label="Hashni nusxalash" />
          {detail.commitment && (
            <div className="space-y-1 border-t border-border pt-2 text-xs text-muted">
              <p>
                Ishtirokchilar: <b className="text-foreground">{detail.commitment.entrantsCount}</b> ta · ro&apos;yxat hashi: <code className="break-all text-foreground">{shortHash(detail.commitment.entrantsHash)}</code>
              </p>
              <p>
                Ro&apos;yxat yopilganda qotiriladi (adolat uchun). Yopilgandan keyin siz qo&apos;lda hal qilgan o&apos;zgarishlar: <b className="text-foreground">{detail.commitment.changesAfterCommit}</b> ta
                — ular qur&apos;a yozuviga ham kiradi.
              </p>
            </div>
          )}
        </div>
      )}

      {giveaway.status === "CLOSED" && (detail.counts.PENDING_CHECK ?? 0) > 0 && (
        <Notice tone="warning">
          {detail.counts.PENDING_CHECK} ta ishtirokchi kutmoqda va qur&apos;aga kirmaydi. Avval ularni hal qiling («Tekshirib bo&apos;lmaydiganlarni qabul qilish» yoki qo&apos;lda).
        </Notice>
      )}
      {giveaway.status === "CLOSED" && canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <ConfirmButton
            label="Qur'a tashlash"
            question="Qur'a tashlansinmi? Seed ochiladi."
            confirmLabel="Ha, tashlash"
            busy={busy === "draw"}
            onConfirm={() => void runAction("draw", "draw").then((r) => !r.ok && setError(r.error))}
          />
          <span className="text-xs text-muted">Faqat «Qabul qilindi» holatidagilar ({giveaway.eligibleCount} ta) qatnashadi.</span>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {current && (
        <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">Qur&apos;a №{current.sequence}</p>
            <Pill tone={DRAW_STATUS[current.status].tone}>{DRAW_STATUS[current.status].label}</Pill>
            <span className="text-xs text-muted">
              {formatDateTime(current.drawnAt)} · {current.entrantsCount} ishtirokchi
            </span>
          </div>
          <People title="G'oliblar" people={current.winners} />
          <People title="Zaxira g'oliblar" people={current.backups} />
          <div className="space-y-1">
            <p className="text-xs font-semibold text-muted">Tekshirish satri (istalgan odam qayta hisoblay oladi)</p>
            <code className="block break-all rounded-md bg-surface px-2 py-1.5 text-xs text-foreground">{current.verification}</code>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={current.verification} label="Nusxalash" />
              <button type="button" className={secondaryButton} onClick={() => void check(current)}>
                Tekshirish
              </button>
            </div>
            {verifyOf(current)}
          </div>

          {canManage && current.status === "DRAWN" && (
            <div className="space-y-1">
              <ConfirmButton
                label="Tasdiqlash"
                question="Natijani tasdiqlaysizmi?"
                confirmLabel="Ha, tasdiqlash"
                busy={busy === `confirm-${current.sequence}`}
                onConfirm={() => void confirm(current)}
              />
              <p className="text-xs text-muted">Tasdiqlamaguncha g&apos;oliblarga hech qanday xabar ketmaydi. G&apos;olib sizga mos kelmasa, uni ishtirokchilar ro&apos;yxatidan chetlating — qur&apos;a yangi commitment bilan qayta tashlanadi.</p>
            </div>
          )}
          {canManage && current.status === "CONFIRMED" && (
            <div className="space-y-1">
              <ConfirmButton
                label="G'oliblarga xabar"
                question="Xabar yuborilsinmi?"
                confirmLabel="Ha, yuborish"
                busy={busy === `notify-${current.sequence}`}
                onConfirm={() => void announce(current)}
              />
              <p className="text-xs text-muted">
                24 soatlik oyna ochiq bo&apos;lsa Direct xabar; yopiq bo&apos;lsa izoh ostida bitta ochiq javob («Direct&apos;ga yozing»). G&apos;oliblar ro&apos;yxati har doim sizga Telegram&apos;ga ham keladi. Qayta bosish ikkinchi xabar yubormaydi.
              </p>
            </div>
          )}

          {current.winners.some((w) => notifications[w.id]?.length) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted">Xabar natijasi</p>
              <ul className="space-y-2">
                {current.winners.map((w) => (
                  <li key={w.id} className="text-sm">
                    <b className="text-foreground">{personName(w)}</b>
                    <ul className="mt-1 space-y-1">
                      {(notifications[w.id] ?? []).map((n, i) => {
                        const st = NOTIFICATION_STATUS[n.status] ?? { label: n.status, tone: "muted" as const };
                        return (
                          <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="text-muted">{CHANNEL_LABELS[n.channel] ?? n.channel}</span>
                            <Pill tone={st.tone}>{st.label}</Pill>
                            {n.reason && <span className="break-words text-muted">{n.reason}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {notify && notify.telegram === "FAILED" && <Notice tone="warning">Telegram xabari ketmadi: workspace Telegram&apos;i ulanganini tekshiring.</Notice>}
        </div>
      )}

      {draws.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted hover:text-foreground">Barcha qur&apos;alar tarixi ({draws.length})</summary>
          <ul className="divide-y divide-border border-t border-border">
            {[...draws].reverse().map((d) => (
              <li key={d.id} className="space-y-1 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-foreground">№{d.sequence}</b>
                  <Pill tone={DRAW_STATUS[d.status].tone}>{DRAW_STATUS[d.status].label}</Pill>
                  <span className="text-muted">{formatDateTime(d.drawnAt)}</span>
                </div>
                <p className="break-all text-muted">Commitment: {shortHash(d.seedCommitment)} · Seed: {shortHash(d.seedRevealed)}</p>
                {d.voidReason && <p className="text-muted">Bekor qilish sababi: {d.voidReason}</p>}
                <button type="button" className="text-accent hover:underline" onClick={() => void check(d)}>
                  Tekshirish
                </button>
                {verifyOf(d)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {!current && draws.length === 0 && giveaway.status === "DRAWN" && <Notice tone="warning">Qur&apos;a yozuvi topilmadi.</Notice>}
    </div>
  );
}
