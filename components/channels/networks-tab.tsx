"use client";

/**
 * Kanallar → Tarmoqlar: every network on equal footing. Instagram, Facebook,
 * Threads, YouTube and Telegram each get the same card: the connected
 * accounts with their health, a disconnect (two-step, no browser dialog) and
 * the connect button. Instagram and Telegram keep their own connect flows
 * (Instagram OAuth returns here; Telegram adds the bot as a channel admin),
 * the rest go through the credential vault.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge, Button } from "@/components/assistant-ui";
import { Card } from "@/components/ui/page";
import { ChannelMark, NETWORK_NAME, formatDateTime, type ChannelKey, type NetworkKey } from "@/components/channels/ui";
import { jsonInit, requestJson } from "@/lib/request-json";

type Tone = "success" | "warning" | "error" | "muted";

export interface VaultCredential {
  id: string;
  channel: string;
  externalAccountId: string;
  label: string | null;
  status: "ACTIVE" | "EXPIRING" | "ERROR" | "REVOKED";
  checkedAt: string | null;
  lastErrorCode: string | null;
}

interface InstagramRow {
  id: string;
  username: string;
  name: string | null;
  tokenStatus: "ACTIVE" | "BROKEN";
  tokenExpiresAt: string | null;
  canPublish: boolean;
  webhookSubscribed: boolean;
  disconnected: boolean;
}

interface TelegramRow {
  id: string;
  title: string | null;
  username: string | null;
  status: "ACTIVE" | "MISSING_RIGHTS" | "REMOVED";
  missingRights: string[];
}

interface Row {
  id: string;
  name: string;
  detail: string;
  status: { label: string; tone: Tone };
  /** Shown under the detail line when the account needs attention. */
  problem?: string | null;
  actions: Array<{ label: string; tone?: "ghost" | "danger"; confirm?: string; run: () => Promise<void> } | { label: string; href: string; external?: boolean }>;
}

const ORDER: NetworkKey[] = ["instagram", "facebook", "threads", "youtube", "telegram"];

const HINT: Record<NetworkKey, string> = {
  instagram: "Post, Reels, Story va karusel. Komment va DM avtomatlashtirish, kampaniyalar.",
  facebook: "Sahifaga post, rasm, video va Reels. Kommentlarga javob, Messenger.",
  threads: "Matn, rasm, video va karusel. Javoblarni boshqarish va yashirish.",
  youtube: "Video va Shorts. Kommentlarga javob. Google tasdiqlamaguncha video private chiqadi.",
  telegram: "Kanalga post, rasm va video. Bot kanalga admin qilib qo'shiladi.",
};

const VAULT_STATUS: Record<VaultCredential["status"], { label: string; tone: Tone }> = {
  ACTIVE: { label: "Ulangan", tone: "success" },
  EXPIRING: { label: "Muddati tugayapti", tone: "warning" },
  ERROR: { label: "Qayta ulang", tone: "error" },
  REVOKED: { label: "Uzilgan", tone: "muted" },
};

const DAY = 24 * 60 * 60 * 1000;

function instagramStatus(a: InstagramRow, now: number): { label: string; tone: Tone } {
  if (a.disconnected) return { label: "Uzilgan", tone: "muted" };
  if (a.tokenStatus === "BROKEN") return { label: "Qayta ulang", tone: "error" };
  if (a.tokenExpiresAt && new Date(a.tokenExpiresAt).getTime() - now < 14 * DAY) return { label: "Muddati tugayapti", tone: "warning" };
  return { label: "Ulangan", tone: "success" };
}

export default function NetworksTab({
  credentials,
  canManage,
  onChanged,
  onNotice,
}: {
  credentials: VaultCredential[];
  canManage: boolean;
  /** Reload the vault credentials after a change. */
  onChanged: () => Promise<void>;
  onNotice: (notice: { tone: "success" | "error"; text: string }) => void;
}) {
  const [instagram, setInstagram] = useState<InstagramRow[]>([]);
  const [telegram, setTelegram] = useState<{ configured: boolean; botUsername: string | null; channels: TelegramRow[] }>({ configured: false, botUsername: null, channels: [] });
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    const [ig, tg] = await Promise.all([
      requestJson<{ instagramAccounts: InstagramRow[] }>("/api/instagram/accounts"),
      requestJson<{ configured: boolean; botUsername: string | null; channels: TelegramRow[] }>("/api/telegram"),
    ]);
    if (ig.ok) setInstagram(ig.data.instagramAccounts);
    if (tg.ok) setTelegram({ configured: tg.data.configured, botUsername: tg.data.botUsername, channels: tg.data.channels });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const call = async (url: string, body: Record<string, unknown>, ok: string, after: () => Promise<void>) => {
    const res = await requestJson(url, jsonInit("POST", body));
    onNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await after();
  };

  const rows: Record<NetworkKey, Row[]> = {
    instagram: [...instagram]
      .sort((a, b) => Number(a.disconnected) - Number(b.disconnected))
      .map((a) => ({
        id: a.id,
        name: `@${a.username}`,
        detail: a.disconnected
          ? "Avtomatlashtirish to'xtagan. Qayta ulasangiz kampaniyalar qaytadi."
          : [a.canPublish ? "Post chiqarish mumkin" : "Post chiqarish ruxsati yo'q", a.webhookSubscribed ? "xabarlar keladi" : "webhook kutilmoqda"].join(" · "),
        status: instagramStatus(a, now),
        problem: !a.disconnected && a.tokenStatus === "BROKEN" ? "Meta ulanishni uzdi: avtomatlashtirish ishlamayapti. Qayta ulang." : null,
        actions: a.disconnected || a.tokenStatus === "BROKEN"
          ? [{ label: "Qayta ulash", href: "/api/instagram/connect?return=/channels" }]
          : [{ label: "Uzish", tone: "danger", confirm: "Avtomatlashtirish va post chiqarish to'xtaydi. Uzilsinmi?", run: () => call("/api/instagram/disconnect", { instagramAccountId: a.id }, `@${a.username} uzildi`, load) }],
      })),
    ...(Object.fromEntries(
      (["facebook", "threads", "youtube"] as ChannelKey[]).map((key) => [
        key,
        credentials
          .filter((c) => c.channel === key && c.status !== "REVOKED")
          .map<Row>((c) => ({
            id: c.id,
            name: c.label ?? c.externalAccountId,
            detail: `Tekshirildi: ${formatDateTime(c.checkedAt)}${c.lastErrorCode ? ` · xato: ${c.lastErrorCode}` : ""}`,
            status: VAULT_STATUS[c.status],
            problem: c.status === "ERROR" ? "Ulanish ishlamayapti: qayta ulang." : null,
            actions: [{ label: "Uzish", tone: "danger", confirm: "Bu akkauntga post va javoblar to'xtaydi. Uzilsinmi?", run: () => call("/api/channels/credentials", { action: "revoke", id: c.id }, "Akkaunt uzildi", onChanged) }],
          })),
      ])
    ) as Record<ChannelKey, Row[]>),
    telegram: telegram.channels
      .filter((c) => c.status !== "REMOVED")
      .map((c) => ({
        id: c.id,
        name: c.title ?? (c.username ? `@${c.username}` : "Telegram kanal"),
        detail: c.username ? `@${c.username}` : "Yopiq kanal",
        status: c.status === "ACTIVE" ? { label: "Ulangan", tone: "success" as const } : { label: "Huquq yetishmaydi", tone: "warning" as const },
        problem: c.missingRights.length ? `Botga bu huquqlarni bering: ${c.missingRights.join(", ")}` : null,
        actions: [
          { label: "Tekshirish", tone: "ghost", run: () => call("/api/telegram", { action: "recheck", id: c.id }, "Tekshirildi", load) },
          { label: "Uzish", tone: "danger", confirm: "Kanalga post chiqarish to'xtaydi. Uzilsinmi?", run: () => call("/api/telegram", { action: "disconnect", id: c.id }, "Kanal uzildi", load) },
        ],
      })),
  };

  const connectOf = (key: NetworkKey): { href: string; external?: boolean } | null => {
    if (key === "instagram") return { href: "/api/instagram/connect?return=/channels" };
    if (key === "telegram") return telegram.configured && telegram.botUsername ? { href: `https://t.me/${telegram.botUsername}?startchannel&admin=post_messages+edit_messages+delete_messages`, external: true } : null;
    return { href: `/api/channels/connect/${key}` };
  };

  const live = (key: NetworkKey) => rows[key].filter((r) => r.status.label !== "Uzilgan");
  const needsCare = (key: NetworkKey) => rows[key].some((r) => r.status.tone === "error" || r.status.tone === "warning");

  return (
    <div className="space-y-5">
      <nav aria-label="Tarmoqlar" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {ORDER.map((key) => {
          const count = live(key).length;
          return (
            <a key={key} href={`#net-${key}`} className="inset flex items-center gap-3 p-3 transition-colors hover:bg-white/8">
              <ChannelMark channel={key} size="sm" />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-white">{NETWORK_NAME[key]}</span>
                <span className={`block text-xs ${needsCare(key) ? "text-warning" : count ? "text-lime" : "text-muted"}`}>
                  {needsCare(key) ? "E'tibor kerak" : count ? `${count} ta ulangan` : "Ulanmagan"}
                </span>
              </span>
            </a>
          );
        })}
      </nav>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ORDER.map((key) => {
          const list = rows[key];
          const connect = connectOf(key);
          return (
            <Card key={key} className="flex flex-col gap-4">
              <div id={`net-${key}`} className="flex scroll-mt-24 items-start gap-3">
                <ChannelMark channel={key} />
                <div className="min-w-0">
                  <h2 className="text-base font-bold text-white">{NETWORK_NAME[key]}</h2>
                  <p className="mt-1 text-sm leading-6 text-muted">{HINT[key]}</p>
                </div>
              </div>

              {list.length === 0 ? (
                <div className="inset px-4 py-5 text-center text-sm text-muted">Hali ulanmagan</div>
              ) : (
                <ul className="space-y-2">
                  {list.map((row) => (
                    <AccountRow key={row.id} row={row} canManage={canManage} />
                  ))}
                </ul>
              )}

              {canManage && (
                <div className="mt-auto flex flex-wrap gap-2">
                  {connect ? (
                    <a className="btn btn-sm btn-lime" href={connect.href} {...(connect.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                      {list.length ? "Yana qo'shish" : "Ulash"}
                    </a>
                  ) : (
                    <span className="text-xs text-muted">Telegram bot serverda sozlanmagan.</span>
                  )}
                  {key === "telegram" && (
                    <a className="btn btn-sm btn-ghost" href="/telegram">
                      Telegram bo&apos;limi
                    </a>
                  )}
                </div>
              )}
              {canManage && key === "telegram" && connect && (
                <p className="-mt-2 text-xs text-muted">Telegram ochiladi: kanalni tanlang va botni admin qiling, so&apos;ng shu sahifani yangilang.</p>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function AccountRow({ row, canManage }: { row: Row; canManage: boolean }) {
  const [asking, setAsking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };

  const action = asking === null ? null : row.actions[asking];
  return (
    <li className="inset space-y-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-semibold text-white">{row.name}</span>
        <Badge tone={row.status.tone}>{row.status.label}</Badge>
      </div>
      <p className="text-xs text-muted">{row.detail}</p>
      {row.problem && <p className="text-xs font-medium text-warning">{row.problem}</p>}

      {canManage &&
        (action && "run" in action ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-white">{action.confirm}</span>
            <Button tone="danger" disabled={busy} onClick={() => void run(action.run)}>
              {busy ? "…" : "Ha, uzish"}
            </Button>
            <Button tone="ghost" disabled={busy} onClick={() => setAsking(null)}>
              Yo&apos;q
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            {row.actions.map((a, i) =>
              "href" in a ? (
                <a key={a.label} className="btn btn-sm btn-lime" href={a.href}>
                  {a.label}
                </a>
              ) : (
                <Button key={a.label} tone={a.tone ?? "ghost"} disabled={busy} onClick={() => (a.confirm ? setAsking(i) : void run(a.run))}>
                  {a.label}
                </Button>
              )
            )}
          </div>
        ))}
    </li>
  );
}
