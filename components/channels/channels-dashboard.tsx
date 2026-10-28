"use client";

/**
 * Channels: Facebook Page, Threads and YouTube on the main dashboard.
 * Three tabs: connected accounts (OAuth connect, status from the vault,
 * disconnect), the inbox (comments and Messenger; public / private reply,
 * hide) and cross-posting Content Plan posts to those accounts.
 * Reads are open to every role; connecting and replying need owner/admin.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, inputClass } from "@/components/assistant-ui";
import { Card, EmptyState, Label, PageHeader } from "@/components/ui/page";
import { CHANNEL_NAME, ChannelMark, FlashNotice, Tabs, formatDateTime, type ChannelKey } from "@/components/channels/ui";
import { takeFlash, type Flash } from "@/lib/flash";
import { jsonInit, requestJson } from "@/lib/request-json";

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

type Tone = "success" | "warning" | "error" | "muted";

const CHANNELS: Array<{ key: ChannelKey; hint: string }> = [
  { key: "facebook", hint: "Post, rasm, video va Reels. Kommentlarga ochiq va shaxsiy javob, Messenger." },
  { key: "threads", hint: "Matn, rasm, video va karusel. Javoblarni boshqarish va yashirish." },
  { key: "youtube", hint: "Video va Shorts. Kommentlarga javob. Google tasdiqlamaguncha video private chiqadi." },
];

const STATUS: Record<Credential["status"], { label: string; tone: Tone }> = {
  ACTIVE: { label: "Ulangan", tone: "success" },
  EXPIRING: { label: "Muddati tugayapti", tone: "warning" },
  ERROR: { label: "Qayta ulang", tone: "error" },
  REVOKED: { label: "Uzilgan", tone: "muted" },
};
const TARGET_STATUS: Record<Target["status"], { label: string; tone: Tone }> = {
  PENDING: { label: "Navbatda", tone: "warning" },
  PUBLISHING: { label: "Chiqmoqda", tone: "warning" },
  PUBLISHED: { label: "Chiqdi", tone: "success" },
  FAILED: { label: "Xato", tone: "error" },
  SKIPPED: { label: "O'tkazildi", tone: "muted" },
  DELETED: { label: "O'chirilgan", tone: "muted" },
};
const POST_STATUS: Record<string, string> = {
  DRAFT: "Qoralama",
  SCHEDULED: "Rejalangan",
  READY_TO_PUBLISH: "Chiqishga tayyor",
  PREPARING: "Tayyorlanmoqda",
  PUBLISHING: "Chiqmoqda",
  PUBLISHED: "Chiqdi",
  PUBLISHED_MANUAL: "Qo'lda chiqdi",
  NEEDS_MANUAL: "Qo'lda chiqarish kerak",
  FAILED: "Xato",
};
const KIND_LABEL: Record<string, string> = { comment: "Komment", reply: "Javob", mention: "Eslatish", dm: "Messenger", postback: "Tugma" };

type Tab = "accounts" | "inbox" | "crosspost";
type Post = (url: string, body: Record<string, unknown>, ok: string) => Promise<boolean>;

const isChannel = (value: string): value is ChannelKey => value in CHANNEL_NAME;

export default function ChannelsDashboard() {
  const [tab, setTab] = useState<Tab>("accounts");
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [caps, setCaps] = useState<Record<string, Capabilities>>({});
  const [canManage, setCanManage] = useState(false);
  const [inbox, setInbox] = useState<InboxMessage[]>([]);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Flash | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const [creds, box, cross] = await Promise.all([
      requestJson<{ credentials: Credential[]; capabilities: Record<string, Capabilities>; canManage: boolean }>("/api/channels/credentials"),
      requestJson<{ messages: InboxMessage[] }>("/api/channels/inbox"),
      requestJson<{ posts: PostRow[] }>("/api/channels/targets"),
    ]);
    if (mine !== seq.current) return;
    if (creds.ok) {
      setCredentials(creds.data.credentials.filter((c) => isChannel(c.channel)));
      setCaps(creds.data.capabilities);
      setCanManage(creds.data.canManage);
    }
    if (box.ok) setInbox(box.data.messages);
    if (cross.ok) setPosts(cross.data.posts);
    const failed = [creds, box, cross].find((r) => !r.ok);
    if (failed && !failed.ok) setNotice({ tone: "error", text: failed.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    // The OAuth outcome arrives in a one-shot cookie (never the URL); drop any stale query string.
    // Strict Mode runs effects twice: the second read finds the cookie gone and must not wipe the notice.
    const flash = takeFlash();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after hydration
    if (flash) setNotice(flash);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    void load();
  }, [load]);

  const post: Post = async (url, body, ok) => {
    setNotice(null);
    const res = await requestJson(url, jsonInit("POST", body));
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load();
    return res.ok;
  };

  const accountName = (id: string) => {
    const cred = credentials.find((c) => c.id === id);
    return cred && isChannel(cred.channel) ? `${CHANNEL_NAME[cred.channel]} · ${cred.label ?? cred.externalAccountId}` : id;
  };

  const connected = credentials.filter((c) => c.status !== "REVOKED").length;
  const unread = inbox.filter((m) => m.direction === "IN").length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        description="Facebook sahifa, Threads va YouTube'ni ulang: kommentlar va xabarlar bitta joyda, postlar esa Kontent rejadan o'zi chiqadi."
        actions={
          <Button tone="ghost" disabled={loading} onClick={() => void load()}>
            {loading ? "Yangilanmoqda…" : "Yangilash"}
          </Button>
        }
      />

      <FlashNotice flash={notice} />
      {!canManage && !loading && credentials.length > 0 && <FlashNotice flash={{ tone: "warning", text: "Ulash va javob yozishni faqat workspace egasi yoki admin qila oladi. Siz ko'ra olasiz." }} />}

      <Tabs tabs={[["accounts", "Akkauntlar", connected], ["inbox", "Xabarlar", unread], ["crosspost", "Kross-post"]]} value={tab} onChange={setTab} />

      {tab === "accounts" ? (
        <AccountsTab credentials={credentials} canManage={canManage} onRevoke={(id) => void post("/api/channels/credentials", { action: "revoke", id }, "Akkaunt uzildi")} />
      ) : tab === "inbox" ? (
        <InboxTab inbox={inbox} caps={caps} canManage={canManage} accountName={accountName} post={post} />
      ) : (
        <CrossPostTab posts={posts} credentials={credentials} canManage={canManage} accountName={accountName} post={post} />
      )}
    </div>
  );
}

function AccountsTab({ credentials, canManage, onRevoke }: { credentials: Credential[]; canManage: boolean; onRevoke: (id: string) => void }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {CHANNELS.map((channel) => {
        const rows = credentials.filter((c) => c.channel === channel.key && c.status !== "REVOKED");
        return (
          <Card key={channel.key} className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <ChannelMark channel={channel.key} />
              <div className="min-w-0">
                <h2 className="text-base font-bold text-white">{CHANNEL_NAME[channel.key]}</h2>
                <p className="mt-1 text-sm leading-6 text-muted">{channel.hint}</p>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="inset px-4 py-5 text-center text-sm text-muted">Hali ulanmagan</div>
            ) : (
              <div className="space-y-2">
                {rows.map((cred) => (
                  <div key={cred.id} className="inset space-y-2 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 break-words text-sm font-semibold text-white">{cred.label ?? cred.externalAccountId}</span>
                      <Badge tone={STATUS[cred.status].tone}>{STATUS[cred.status].label}</Badge>
                    </div>
                    <p className="text-xs text-muted">
                      Tekshirildi: {formatDateTime(cred.checkedAt)}
                      {cred.lastErrorCode ? ` · xato: ${cred.lastErrorCode}` : ""}
                    </p>
                    {canManage && (
                      <Button tone="danger" onClick={() => onRevoke(cred.id)}>
                        Uzish
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {canManage && (
              <a className="btn btn-sm btn-lime mt-auto" href={`/api/channels/connect/${channel.key}`}>
                {rows.length ? "Yana qo'shish / qayta ulash" : "Ulash"}
              </a>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function InboxTab({ inbox, caps, canManage, accountName, post }: { inbox: InboxMessage[]; caps: Record<string, Capabilities>; canManage: boolean; accountName: (id: string) => string; post: Post }) {
  const [channel, setChannel] = useState<"" | ChannelKey>("");
  const [replyTo, setReplyTo] = useState<{ id: string; mode: "public" | "private" | "dm" } | null>(null);
  const [text, setText] = useState("");
  const rows = inbox.filter((m) => !channel || m.channel === channel);

  const send = async () => {
    if (!replyTo || !text.trim()) return;
    if (await post("/api/channels/inbox", { action: "reply", id: replyTo.id, mode: replyTo.mode, text }, "Javob yuborildi")) {
      setReplyTo(null);
      setText("");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {([["", "Hammasi"], ...CHANNELS.map((c) => [c.key, CHANNEL_NAME[c.key]])] as Array<["" | ChannelKey, string]>).map(([key, label]) => (
          <button key={key || "all"} type="button" onClick={() => setChannel(key)} className={`chip ${channel === key ? "chip-active" : ""}`} aria-pressed={channel === key}>
            {label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <Card>
          <EmptyState title="Xabar yo'q" body="Sahifangizga komment yoki Messenger xabari kelganda shu yerda ko'rinadi. Avval «Akkauntlar» bo'limida kanalni ulang." />
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((m) => {
            const cap = caps[m.channel];
            const isComment = m.kind === "comment" || m.kind === "reply" || m.kind === "mention";
            return (
              <Card key={m.id} className={m.direction === "OUT" ? "opacity-75" : ""}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  <ChannelMark channel={m.channel} size="sm" />
                  <Badge tone="muted">{KIND_LABEL[m.kind] ?? m.kind}</Badge>
                  <span>{accountName(m.accountRef)}</span>
                  <span>· {formatDateTime(m.createdAt)}</span>
                  {m.direction === "OUT" && <span>· bizning javob</span>}
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-6 text-white">
                  {m.authorName && <b>{m.authorName}: </b>}
                  {m.text || "—"}
                </p>
                {m.direction === "IN" && canManage && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {isComment ? (
                      <>
                        <Button tone="ghost" onClick={() => setReplyTo({ id: m.id, mode: "public" })}>
                          Ochiq javob
                        </Button>
                        {cap?.private_reply_window_days != null && (
                          <Button tone="ghost" onClick={() => setReplyTo({ id: m.id, mode: "private" })}>
                            Shaxsiy javob
                          </Button>
                        )}
                        {cap?.supports_hide && (
                          <Button tone="ghost" onClick={() => void post("/api/channels/inbox", { action: "hide", id: m.id, hide: true }, "Yashirildi")}>
                            Yashirish
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button tone="ghost" onClick={() => setReplyTo({ id: m.id, mode: "dm" })}>
                        Javob (Messenger)
                      </Button>
                    )}
                  </div>
                )}
                {replyTo?.id === m.id && (
                  <div className="inset mt-3 space-y-3 p-4">
                    <textarea
                      className={inputClass}
                      rows={3}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={replyTo.mode === "private" ? "Shaxsiy javob: bir marta, 7 kun ichida" : "Javob matni"}
                    />
                    <div className="flex gap-2">
                      <Button tone="lime" disabled={!text.trim()} onClick={() => void send()}>
                        Yuborish
                      </Button>
                      <Button tone="ghost" onClick={() => setReplyTo(null)}>
                        Bekor
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CrossPostTab({ posts, credentials, canManage, accountName, post }: { posts: PostRow[]; credentials: Credential[]; canManage: boolean; accountName: (id: string) => string; post: Post }) {
  const usable = credentials.filter((c) => c.status === "ACTIVE" || c.status === "EXPIRING");
  if (posts.length === 0) {
    return (
      <Card>
        <EmptyState title="Postlar yo'q" body="Kontent rejada post yarating: oxirgi 7 kun va kelgusi postlar shu yerda ko'rinadi. Har bir postni qaysi kanallarga ham chiqarishni shu yerda tanlaysiz." />
      </Card>
    );
  }

  const toggle = (row: PostRow, cred: Credential) => {
    const current = row.targets.filter((t) => t.channel === cred.channel && t.status !== "DELETED").map((t) => t.accountRef);
    const next = current.includes(cred.id) ? current.filter((id) => id !== cred.id) : [...current, cred.id];
    void post("/api/channels/targets", { postId: row.id, channel: cred.channel, accountIds: next }, "Saqlandi");
  };

  return (
    <div className="space-y-3">
      {usable.length === 0 && <FlashNotice flash={{ tone: "warning", text: "Avval «Akkauntlar» bo'limida kamida bitta kanalni ulang." }} />}
      {posts.map((row) => (
        <Card key={row.id}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="accent">{row.type}</Badge>
            <span>{formatDateTime(row.scheduledAt)}</span>
            <span>· {POST_STATUS[row.status] ?? row.status}</span>
          </div>
          <p className="mt-3 line-clamp-2 break-words text-[15px] leading-6 text-white">{row.caption || "Matnsiz post"}</p>

          {usable.length > 0 && (
            <div className="mt-4">
              <Label>Qaysi kanallarga ham chiqsin</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {usable.map((cred) => {
                  const on = row.targets.some((t) => t.accountRef === cred.id && t.status !== "DELETED");
                  return (
                    <button key={cred.id} type="button" disabled={!canManage} aria-pressed={on} onClick={() => toggle(row, cred)} className={`chip disabled:opacity-60 ${on ? "chip-active" : ""}`}>
                      {accountName(cred.id)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {row.targets.filter((t) => t.channel !== "telegram").length > 0 && (
            <div className="inset mt-4 space-y-2 p-4">
              {row.targets
                .filter((t) => t.channel !== "telegram")
                .map((t) => (
                  <div key={t.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={TARGET_STATUS[t.status].tone}>{TARGET_STATUS[t.status].label}</Badge>
                    <span className="text-muted">{accountName(t.accountRef)}</span>
                    {t.nextAttemptAt && t.status !== "PUBLISHED" && <span className="text-muted">· keyingi urinish {formatDateTime(t.nextAttemptAt)}</span>}
                    {t.lastError && <span className="break-words text-error">· {t.lastError}</span>}
                  </div>
                ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
