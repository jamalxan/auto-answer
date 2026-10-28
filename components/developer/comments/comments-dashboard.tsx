"use client";

/**
 * ETAP 2 — Comment Automation 2.0, campaign list. Each card shows where every
 * comment is right now (TZ "queue visibility") and anything that silently
 * stops replies: paused, broken token, unapproved variants.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DevBadge, EmptyState, formatDateTime, Pill, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import { LegacyMigrationPanel, type LegacyMigrationView } from "./legacy-migration";
import { ConfirmButton, Notice } from "./parts";
import { BACKTRACK_STATUS, jsonInit, MATCH_MODE_TEXT, requestJson, type Account } from "./shared";

interface CampaignRow {
  id: string;
  name: string;
  triggerType: "COMMENT" | "LIVE_COMMENT";
  active: boolean;
  mediaScope: "ANY" | "SPECIFIC";
  mediaIds: string[];
  matchingMode: keyof typeof MATCH_MODE_TEXT;
  keywords: string[];
  intents: string[];
  priority: number;
  publicReplyEnabled: boolean;
  openingButtonLabel: string | null;
  createdAt: string;
  instagramAccount: { username: string; tokenStatus: string };
  _count: { quickReplies: number; followUpSteps: number };
  variants: { dmApproved: number; publicApproved: number; unapproved: number };
  stats: {
    executions: Record<"PENDING" | "SENDING" | "SENT" | "RETRYING" | "FAILED" | "SKIPPED", number>;
    publicSent: number;
    publicFailed: number;
    opened: number;
    leads: number;
    handoffs: number;
    followUps: Record<string, number>;
  };
  lastBacktrack: { status: string; startedAt: string; queued: number; scanned: number } | null;
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="panel min-w-0 rounded-xl px-4 py-3">
      <p className="label-mono break-words text-[10px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 break-words text-xl font-bold leading-tight ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <span className="whitespace-nowrap">
      {label}: <b className={value ? (tone ?? "text-foreground") : ""}>{value}</b>
    </span>
  );
}

function CampaignCard({ campaign, onChanged }: { campaign: CampaignRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const e = campaign.stats.executions;
  const queued = e.PENDING + e.SENDING + e.RETRYING;
  const f = campaign.stats.followUps;

  async function mutate(init: RequestInit, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await requestJson(`/api/comments/campaigns/${campaign.id}`, init);
      if (!res.ok) setError(res.error || fallback);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  const warnings: string[] = [];
  if (campaign.instagramAccount.tokenStatus === "BROKEN") {
    warnings.push("Akkaunt ulanishi uzilgan — javoblar ketmaydi. Foundation → Ulanishlar bo'limida qayta ulang.");
  }
  if (campaign.variants.unapproved > 0) {
    warnings.push(`${campaign.variants.unapproved} ta variant tasdiqlanmagan — ular yuborilmaydi.`);
  }
  if (campaign.publicReplyEnabled && campaign.variants.publicApproved === 0) {
    warnings.push("Ochiq javob yoqilgan, lekin tasdiqlangan variant yo'q.");
  }

  return (
    <li className="panel rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/comments/${campaign.id}`} className="break-words font-semibold text-foreground hover:text-accent">
              {campaign.name}
            </Link>
            <Pill tone={campaign.active ? "success" : "muted"}>{campaign.active ? "Faol" : "O'chiq"}</Pill>
            <span
              className={`label-mono rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                campaign.triggerType === "LIVE_COMMENT" ? "bg-error/10 text-error" : "bg-surface-hover text-muted"
              }`}
            >
              {campaign.triggerType === "LIVE_COMMENT" ? "LIVE" : "POST"}
            </span>
            {campaign.priority !== 0 && <span className="label-mono text-[10px] text-muted">prioritet {campaign.priority}</span>}
          </div>
          <p className="mt-1 text-xs text-muted">
            @{campaign.instagramAccount.username} ·{" "}
            {campaign.triggerType === "LIVE_COMMENT"
              ? "Live efir kommentlari"
              : campaign.mediaScope === "ANY"
                ? "Har qanday post"
                : `${campaign.mediaIds.length} ta post`}{" "}
            ·{" "}
            {MATCH_MODE_TEXT[campaign.matchingMode]?.title ?? campaign.matchingMode}
            {campaign.openingButtonLabel ? ` · tugma “${campaign.openingButtonLabel}”` : ""}
          </p>
          {(campaign.keywords.length > 0 || campaign.intents.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {campaign.keywords.slice(0, 12).map((k) => (
                <span key={k} className="rounded-md bg-accent/10 px-1.5 py-0.5 text-xs text-foreground">
                  {k}
                </span>
              ))}
              {campaign.intents.map((k) => (
                <span key={k} className="label-mono rounded-md bg-gold/10 px-1.5 py-0.5 text-[10px] text-gold">
                  {k}
                </span>
              ))}
              {campaign.keywords.length > 12 && <span className="text-xs text-muted">+{campaign.keywords.length - 12}</span>}
            </div>
          )}
        </div>
        <Toggle
          on={campaign.active}
          onChange={(on) =>
            void mutate(jsonInit("PATCH", { active: on }), "Holatni o'zgartirib bo'lmadi")
          }
          label={`${campaign.name} faol`}
        />
      </div>

      {warnings.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {warnings.map((w) => (
            <Notice key={w} tone="warning">
              {w}
            </Notice>
          ))}
        </div>
      )}

      <div className="mt-3 grid gap-2 border-t border-border pt-3 text-xs text-muted sm:grid-cols-2">
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Count label="Yuborildi" value={e.SENT} tone="text-success" />
          <Count label="Navbatda" value={queued} tone="text-warning" />
          <Count label="Xato" value={e.FAILED} tone="text-error" />
          <Count label="O'tkazildi" value={e.SKIPPED} />
          {campaign.publicReplyEnabled && (
            <span className="whitespace-nowrap">
              Ochiq javob: <b className="text-foreground">{campaign.stats.publicSent}</b>
              {campaign.stats.publicFailed > 0 && <b className="text-error"> / {campaign.stats.publicFailed} xato</b>}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Count label="Tugma bosdi" value={campaign.stats.opened} />
          <Count label="Lead" value={campaign.stats.leads} tone="text-success" />
          <Count label="Operator" value={campaign.stats.handoffs} />
          {campaign._count.followUpSteps > 0 && (
            <span className="whitespace-nowrap">
              Follow-up: <b className="text-foreground">{f.SENT ?? 0}</b> yuborildi · <b>{f.SCHEDULED ?? 0}</b> rejada
              {(f.FAILED ?? 0) > 0 && <b className="text-error"> · {f.FAILED} xato</b>}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">
          {campaign.lastBacktrack
            ? `Oxirgi skan: ${formatDateTime(campaign.lastBacktrack.startedAt)} · ${
                BACKTRACK_STATUS[campaign.lastBacktrack.status]?.label ?? campaign.lastBacktrack.status
              } · ${campaign.lastBacktrack.queued} navbatga`
            : `Yaratildi: ${formatDateTime(campaign.createdAt)}`}
        </span>
        <div className="flex flex-wrap gap-2">
          <Link href={`/comments/${campaign.id}?tab=logs`} className={secondaryButton}>
            Loglar
          </Link>
          <Link href={`/comments/${campaign.id}`} className={secondaryButton}>
            Tahrirlash
          </Link>
          <ConfirmButton
            label="O'chirish"
            question="Kampaniya va uning loglari o'chirilsinmi?"
            confirmLabel="O'chirish"
            danger
            busy={busy}
            onConfirm={() => void mutate({ method: "DELETE" }, "O'chirib bo'lmadi")}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-error">{error}</p>}
    </li>
  );
}

interface LegacyRow {
  id: string;
  name: string;
  isActive: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  postId: string | null;
  matchAnyPost: boolean;
  instagramAccount: { username: string };
  stats: { total: number; sent: number; failed: number; skipped: number };
}

/**
 * B-34: production (old) campaigns. Read-only here, except their move into
 * this engine (audit 2026-10-26): a switched-off copy is compared on every
 * comment before it takes over, so a comment never gets two answers.
 */
function LegacySection({ rows, migrations, onChanged }: { rows: LegacyRow[]; migrations: LegacyMigrationView[]; onChanged: () => void }) {
  if (rows.length === 0) return null;
  const byId = new Map(migrations.map((m) => [m.automationId, m]));
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">Production kampaniyalar (eski tizim)</h2>
        <p className="mt-0.5 text-xs text-muted">
          Eski kampaniyalar bu yerda o&apos;zgartirilmaydi. Ko&apos;chirish: avval yangi nusxa o&apos;chiq holda 14 kun har bir kommentda eskisi bilan taqqoslanadi, farq bo&apos;lmasa bir tugma bilan o&apos;tkaziladi va istalgan payt qaytariladi.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="panel rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{row.name}</span>
              <Pill tone="warning">production (eski)</Pill>
              <Pill tone={row.isActive ? "success" : "muted"}>{row.isActive ? "Faol" : "O'chiq"}</Pill>
              <span className="text-xs text-muted">@{row.instagramAccount.username}</span>
            </div>
            <p className="mt-1 text-xs text-muted">
              {row.matchAnyWord ? "Istalgan so'z" : row.keywords.join(", ") || "—"} · {row.matchAnyPost ? "Har qanday post" : row.postId ? "Aniq post" : "Post belgilanmagan"}
            </p>
            <p className="mt-1 text-xs text-muted">
              Yuborildi {row.stats.sent} · Xato {row.stats.failed} · O&apos;tkazib yuborildi {row.stats.skipped} · Jami {row.stats.total}
            </p>
            {byId.get(row.id) && <LegacyMigrationPanel view={byId.get(row.id)!} onChanged={onChanged} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function CommentsDashboard() {
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null>(null);
  const [legacy, setLegacy] = useState<LegacyRow[]>([]);
  const [migrations, setMigrations] = useState<LegacyMigrationView[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [res, moves] = await Promise.all([
      requestJson<{ campaigns: CampaignRow[]; accounts: Account[]; legacy?: LegacyRow[] }>("/api/comments/campaigns"),
      requestJson<{ items: LegacyMigrationView[] }>("/api/comments/legacy"),
    ]);
    if (mine !== seq.current) return;
    if (moves.ok) setMigrations(moves.data.items);
    if (res.ok) {
      setCampaigns(res.data.campaigns);
      setAccounts(res.data.accounts);
      setLegacy(res.data.legacy ?? []);
      setError(null);
    } else {
      setError(res.error);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const totals = (campaigns ?? []).reduce(
    (acc, c) => {
      const e = c.stats.executions;
      acc.active += c.active ? 1 : 0;
      acc.sent += e.SENT;
      acc.queued += e.PENDING + e.SENDING + e.RETRYING;
      acc.failed += e.FAILED;
      acc.leads += c.stats.leads;
      acc.followUps += c.stats.followUps.SCHEDULED ?? 0;
      return acc;
    },
    { active: 0, sent: 0, queued: 0, failed: 0, leads: 0, followUps: 0 }
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Komment avtomatika</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">
            Komment → kalit so&apos;z / intent → DM variant (+ ochiq javob) → tugma → asosiy xabar → follow-up
          </p>
          <p className="mt-1 text-xs text-muted">Post va Live efir kommentlari shu yerda; Live kampaniyalar LIVE belgisi bilan.</p>
        </div>
        {accounts.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Link href="/comments/new?source=live" className={secondaryButton}>
              + Live kampaniya
            </Link>
            <Link href="/comments/new" className={primaryButton}>
              + Yangi kampaniya
            </Link>
          </div>
        )}
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" className={secondaryButton} onClick={() => void load()}>
            Qayta urinish
          </button>
        </div>
      )}

      {campaigns === null ? (
        !error && <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Faol kampaniya" value={`${totals.active} / ${campaigns.length}`} />
            <Stat label="Yuborildi" value={totals.sent} tone="text-success" />
            <Stat label="Navbatda" value={totals.queued} tone={totals.queued ? "text-warning" : undefined} />
            <Stat label="Xato" value={totals.failed} tone={totals.failed ? "text-error" : undefined} />
            <Stat label="Lead" value={totals.leads} />
            <Stat label="Follow-up rejada" value={totals.followUps} />
          </div>

          {campaigns.length === 0 ? (
            <div className="panel rounded-xl">
              <EmptyState
                title="Hali komment kampaniyasi yo'q"
                body={
                  accounts.length
                    ? "Kalit so'z bilan komment yozganlarga avtomatik DM yuboring."
                    : "Avval Instagram akkaunt ulang (Foundation → Ulanishlar)."
                }
              />
              {accounts.length > 0 && (
                <div className="pb-8 text-center">
                  <Link href="/comments/new" className={primaryButton}>
                    + Yangi kampaniya
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <ul className="space-y-3">
              {campaigns.map((campaign) => (
                <CampaignCard key={campaign.id} campaign={campaign} onChanged={() => void load()} />
              ))}
            </ul>
          )}

          <LegacySection rows={legacy} migrations={migrations} onChanged={load} />
        </>
      )}
    </div>
  );
}
