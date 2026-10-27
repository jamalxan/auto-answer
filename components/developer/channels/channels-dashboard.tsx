"use client";

/**
 * Audit T4–T6 — Facebook Page, Threads and YouTube, the developer screen.
 * Three tabs: connected accounts (OAuth connect, status from the vault,
 * revoke), the inbox (comments, Messenger; public / private reply, hide) and
 * cross-posting Content Scheduler posts to those accounts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";
import { DevBadge, Pill, formatDateTime, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";

type ChannelKey = "facebook" | "threads" | "youtube";

interface Credential {
  id: string;
  channel: string;
  externalAccountId: string;
  label: string | null;
  status: "ACTIVE" | "EXPIRING" | "ERROR" | "REVOKED";
  expiresAt: string | null;
  checkedAt: string | null;
  lastErrorCode: string | null;
}

interface Capabilities {
  supports_dm: boolean;
  private_reply_window_days: number | null;
  dm_window_hours: number | null;
  publish_daily_limit: number | null;
  supports_hide: boolean;
  publish_formats: string[];
}

interface InboxMessage {
  id: string;
  channel: ChannelKey;
  accountRef: string;
  kind: string;
  threadRef: string;
  direction: "IN" | "OUT";
  authorName: string | null;
  text: string;
  createdAt: string;
}

interface Target {
  id: string;
  channel: string;
  accountRef: string;
  status: "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "SKIPPED" | "DELETED";
  lastError: string | null;
  nextAttemptAt: string | null;
  publishedAt: string | null;
}

interface PostRow {
  id: string;
  type: string;
  status: string;
  caption: string | null;
  scheduledAt: string | null;
  targets: Target[];
}

const CHANNELS: Array<{ key: ChannelKey; name: string; hint: string }> = [
  { key: "facebook", name: "Facebook sahifa", hint: "Post, rasm, video, Reels (kuniga 30), kommentlar, Messenger (24 soat), shaxsiy javob (7 kun, bir marta)." },
  { key: "threads", name: "Threads", hint: "Matn (500 belgi), rasm, video, karusel (20 tagacha), javoblar va yashirish. DM yo'q." },
  { key: "youtube", name: "YouTube", hint: "Video va Shorts (kunlik kvota ~6 yuklash), kommentlar har 15 daqiqada. Google tasdiqlamaguncha video private chiqadi." },
];
const CHANNEL_NAME: Record<string, string> = { facebook: "Facebook", threads: "Threads", youtube: "YouTube" };

const TABS = [
  ["accounts", "Akkauntlar"],
  ["inbox", "Inbox"],
  ["crosspost", "Kross-post"],
] as const;
type Tab = (typeof TABS)[number][0];

const STATUS: Record<Credential["status"], { label: string; tone: "success" | "warning" | "error" | "muted" }> = {
  ACTIVE: { label: "Ulangan", tone: "success" },
  EXPIRING: { label: "Muddati tugayapti", tone: "warning" },
  ERROR: { label: "Ishlamayapti", tone: "error" },
  REVOKED: { label: "Uzilgan", tone: "muted" },
};
const TARGET_TONE: Record<Target["status"], "success" | "warning" | "error" | "muted"> = {
  PENDING: "warning",
  PUBLISHING: "warning",
  PUBLISHED: "success",
  FAILED: "error",
  SKIPPED: "muted",
  DELETED: "muted",
};
const KIND_LABEL: Record<string, string> = { comment: "Komment", reply: "Javob", mention: "Eslatish", dm: "Messenger", postback: "Tugma" };

export default function ChannelsDashboard() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>("accounts");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [caps, setCaps] = useState<Record<string, Capabilities>>({});
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: "error" | "success" | "warning"; text: string } | null>(() => {
    const error = params.get("error");
    if (error) return { tone: "error", text: error };
    const connected = params.get("connected");
    if (connected) return { tone: params.get("warning") ? "warning" : "success", text: `${CHANNEL_NAME[connected] ?? connected} ulandi (${params.get("count") ?? 1})${params.get("warning") ? ` — ${params.get("warning")}` : ""}` };
    return null;
  });
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const [creds, box, cross] = await Promise.all([
      requestJson<{ credentials: Credential[]; capabilities: Record<string, Capabilities> }>("/api/developer/channels/credentials"),
      requestJson<{ messages: InboxMessage[] }>("/api/developer/channels/inbox"),
      requestJson<{ posts: PostRow[] }>("/api/developer/channels/targets"),
    ]);
    if (mine !== seq.current) return;
    if (creds.ok) {
      setCredentials(creds.data.credentials.filter((c) => c.channel in CHANNEL_NAME));
      setCaps(creds.data.capabilities);
    }
    if (box.ok) setInbox(box.data.messages);
    if (cross.ok) setPosts(cross.data.posts);
    const failed = [creds, box, cross].find((r) => !r.ok);
    if (failed && !failed.ok) setNotice({ tone: "error", text: failed.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const post = async (url: string, body: Record<string, unknown>, ok: string) => {
    setNotice(null);
    const res = await requestJson(url, jsonInit("POST", body));
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load();
    return res.ok;
  };

  const accountName = (id: string) => {
    const cred = credentials.find((c) => c.id === id);
    return cred ? `${CHANNEL_NAME[cred.channel]} · ${cred.label ?? cred.externalAccountId}` : id;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Facebook · Threads · YouTube</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">Kanal adapterlari: ulash, kommentlar va Messenger, Content Scheduler&apos;dan kross-post.</p>
        </div>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yangilanmoqda…" : "Yangilash"}
        </button>
      </div>

      {notice && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            notice.tone === "error" ? "border-error/30 bg-error/10 text-error" : notice.tone === "warning" ? "border-warning/30 bg-warning/10 text-warning" : "border-success/30 bg-success/10 text-success"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === key ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <AccountsTab credentials={credentials} onRevoke={(id) => void post("/api/developer/channels/credentials", { action: "revoke", id }, "Uzildi")} />
      ) : tab === "inbox" ? (
        <InboxTab inbox={inbox} caps={caps} accountName={accountName} post={post} />
      ) : (
        <CrossPostTab posts={posts} credentials={credentials} accountName={accountName} post={post} />
      )}
    </div>
  );
}

type Post = (url: string, body: Record<string, unknown>, ok: string) => Promise<boolean>;

function AccountsTab({ credentials, onRevoke }: { credentials: Credential[]; onRevoke: (id: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {CHANNELS.map((channel) => {
        const rows = credentials.filter((c) => c.channel === channel.key && c.status !== "REVOKED");
        return (
          <div key={channel.key} className="panel flex flex-col gap-3 rounded-xl p-4 text-sm">
            <div>
              <p className="font-semibold text-foreground">{channel.name}</p>
              <p className="mt-1 text-xs text-muted">{channel.hint}</p>
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-muted">Ulanmagan.</p>
            ) : (
              rows.map((cred) => (
                <div key={cred.id} className="inset space-y-1 rounded-lg p-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 break-words font-medium text-foreground">{cred.label ?? cred.externalAccountId}</span>
                    <Pill tone={STATUS[cred.status].tone}>{STATUS[cred.status].label}</Pill>
                  </div>
                  <p className="text-xs text-muted">
                    Tekshirildi: {formatDateTime(cred.checkedAt)}
                    {cred.lastErrorCode ? ` · xato: ${cred.lastErrorCode}` : ""}
                  </p>
                  <button type="button" className={secondaryButton} onClick={() => onRevoke(cred.id)}>
                    Uzish
                  </button>
                </div>
              ))
            )}
            <a className={`${primaryButton} mt-auto text-center`} href={`/api/developer/channels/connect/${channel.key}`}>
              {rows.length ? "Qayta ulash / yana qo'shish" : "Ulash"}
            </a>
          </div>
        );
      })}
    </div>
  );
}

function InboxTab({ inbox, caps, accountName, post }: { inbox: InboxMessage[]; caps: Record<string, Capabilities>; accountName: (id: string) => string; post: Post }) {
  const [channel, setChannel] = useState<"" | ChannelKey>("");
  const [replyTo, setReplyTo] = useState<{ id: string; mode: "public" | "private" | "dm" } | null>(null);
  const [text, setText] = useState("");
  const rows = inbox.filter((m) => !channel || m.channel === channel);

  const send = async () => {
    if (!replyTo || !text.trim()) return;
    if (await post("/api/developer/channels/inbox", { action: "reply", id: replyTo.id, mode: replyTo.mode, text }, "Javob yuborildi")) {
      setReplyTo(null);
      setText("");
    }
  };

  return (
    <div className="space-y-3">
      <select className={`${inputClass} w-auto`} value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} aria-label="Kanal">
        <option value="">Hammasi</option>
        {CHANNELS.map((c) => (
          <option key={c.key} value={c.key}>
            {CHANNEL_NAME[c.key]}
          </option>
        ))}
      </select>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Xabar yo&apos;q.</p>
      ) : (
        rows.map((m) => {
          const cap = caps[m.channel];
          const isComment = m.kind === "comment" || m.kind === "reply" || m.kind === "mention";
          return (
            <div key={m.id} className={`panel space-y-2 rounded-xl p-3 text-sm ${m.direction === "OUT" ? "opacity-70" : ""}`}>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <Pill tone="muted">{KIND_LABEL[m.kind] ?? m.kind}</Pill>
                <span>{accountName(m.accountRef)}</span>
                <span>· {formatDateTime(m.createdAt)}</span>
                {m.direction === "OUT" && <span>· bizning javob</span>}
              </div>
              <p className="whitespace-pre-wrap break-words text-foreground">
                {m.authorName && <b>{m.authorName}: </b>}
                {m.text || "—"}
              </p>
              {m.direction === "IN" && (
                <div className="flex flex-wrap gap-2">
                  {isComment ? (
                    <>
                      <button type="button" className={secondaryButton} onClick={() => setReplyTo({ id: m.id, mode: "public" })}>
                        Ochiq javob
                      </button>
                      {cap?.private_reply_window_days != null && (
                        <button type="button" className={secondaryButton} onClick={() => setReplyTo({ id: m.id, mode: "private" })}>
                          Shaxsiy javob
                        </button>
                      )}
                      {cap?.supports_hide && (
                        <button type="button" className={secondaryButton} onClick={() => void post("/api/developer/channels/inbox", { action: "hide", id: m.id, hide: true }, "Yashirildi")}>
                          Yashirish
                        </button>
                      )}
                    </>
                  ) : (
                    <button type="button" className={secondaryButton} onClick={() => setReplyTo({ id: m.id, mode: "dm" })}>
                      Javob (DM)
                    </button>
                  )}
                </div>
              )}
              {replyTo?.id === m.id && (
                <div className="space-y-2">
                  <textarea className={inputClass} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={replyTo.mode === "private" ? "Shaxsiy javob (bir marta, 7 kun ichida)" : "Javob matni"} />
                  <div className="flex gap-2">
                    <button type="button" className={primaryButton} disabled={!text.trim()} onClick={() => void send()}>
                      Yuborish
                    </button>
                    <button type="button" className={secondaryButton} onClick={() => setReplyTo(null)}>
                      Bekor
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function CrossPostTab({ posts, credentials, accountName, post }: { posts: PostRow[]; credentials: Credential[]; accountName: (id: string) => string; post: Post }) {
  const usable = credentials.filter((c) => c.status === "ACTIVE" || c.status === "EXPIRING");
  if (posts.length === 0) return <p className="py-6 text-center text-sm text-muted">Oxirgi 7 kunda va kelgusida post yo&apos;q.</p>;

  const toggle = (row: PostRow, cred: Credential) => {
    const current = row.targets.filter((t) => t.channel === cred.channel && t.status !== "DELETED").map((t) => t.accountRef);
    const next = current.includes(cred.id) ? current.filter((id) => id !== cred.id) : [...current, cred.id];
    void post("/api/developer/channels/targets", { postId: row.id, channel: cred.channel, accountIds: next }, "Saqlandi");
  };

  return (
    <div className="space-y-3">
      {usable.length === 0 && <p className="text-sm text-muted">Avval «Akkauntlar» bo&apos;limida akkaunt ulang.</p>}
      {posts.map((row) => (
        <div key={row.id} className="panel space-y-2 rounded-xl p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Pill tone="muted">{row.type}</Pill>
            <span>{formatDateTime(row.scheduledAt)}</span>
            <span>· {row.status}</span>
          </div>
          <p className="line-clamp-2 break-words text-foreground">{row.caption || "—"}</p>
          <div className="flex flex-wrap gap-2">
            {usable.map((cred) => {
              const on = row.targets.some((t) => t.accountRef === cred.id && t.status !== "DELETED");
              return (
                <label key={cred.id} className="inline-flex items-center gap-1 text-xs">
                  <input type="checkbox" checked={on} onChange={() => toggle(row, cred)} />
                  {accountName(cred.id)}
                </label>
              );
            })}
          </div>
          {row.targets
            .filter((t) => t.channel !== "telegram")
            .map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Pill tone={TARGET_TONE[t.status]}>{t.status}</Pill>
                <span className="text-muted">{accountName(t.accountRef)}</span>
                {t.nextAttemptAt && t.status !== "PUBLISHED" && <span className="text-muted">· keyingi urinish {formatDateTime(t.nextAttemptAt)}</span>}
                {t.lastError && <span className="break-words text-error">· {t.lastError}</span>}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
