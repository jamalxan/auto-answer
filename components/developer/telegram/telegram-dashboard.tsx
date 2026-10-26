"use client";

/**
 * Audit T3 — Telegram channel, the developer screen. Four tabs: connected
 * channels (rights, discussion group, recheck / disconnect), the inbox
 * (comments, channel DMs, Business chats with reply), cross-posting Content
 * Scheduler posts to channels, and Business connections.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";
import { DevBadge, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";

const API = "/api/developer/telegram";

interface Channel {
  id: string;
  chatId: string;
  title: string | null;
  username: string | null;
  linkedChatId: string | null;
  discussionReady: boolean;
  dmChatId: string | null;
  status: "ACTIVE" | "MISSING_RIGHTS" | "REMOVED";
  missingRights: string[];
  updatedAt: string;
}

interface Business {
  id: string;
  tgUserId: string;
  canReply: boolean;
  isEnabled: boolean;
  createdAt: string;
}

interface InboxMessage {
  id: string;
  accountRef: string;
  kind: "comment" | "channel_dm" | "business_dm";
  threadRef: string;
  direction: "IN" | "OUT";
  authorName: string | null;
  text: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

interface Target {
  id: string;
  accountRef: string;
  status: "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "SKIPPED" | "DELETED";
  lastError: string | null;
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

interface Data {
  configured: boolean;
  botUsername: string | null;
  rightLabels: Record<string, string>;
  channels: Channel[];
  business: Business[];
  inbox: InboxMessage[];
  posts: PostRow[];
}

const TABS = [
  ["channels", "Kanallar"],
  ["inbox", "Inbox"],
  ["crosspost", "Kross-post"],
  ["business", "Business"],
] as const;
type Tab = (typeof TABS)[number][0];

const KIND_LABEL: Record<InboxMessage["kind"], string> = { comment: "Komment", channel_dm: "Kanal DM", business_dm: "Business" };
const TARGET_TONE: Record<Target["status"], "success" | "warning" | "error" | "muted"> = {
  PENDING: "warning",
  PUBLISHING: "warning",
  PUBLISHED: "success",
  FAILED: "error",
  SKIPPED: "muted",
  DELETED: "muted",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" }) : "—");

export default function TelegramDashboard() {
  const [tab, setTab] = useState<Tab>("channels");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    const res = await requestJson<Data>(API);
    if (mine !== seq.current) return;
    if (res.ok) setData(res.data);
    else setNotice({ tone: "error", text: res.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, ok: string) => {
    setNotice(null);
    const res = await requestJson(API, jsonInit("POST", body));
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load();
    return res.ok;
  };

  const channelName = (id: string) => {
    const channel = data?.channels.find((c) => c.id === id);
    return channel ? channel.title ?? channel.username ?? channel.chatId : "Business";
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Telegram kanal</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">Bot kanal admini: nashr, muhokama kommentlari, kanal DM&apos;lari va Telegram Business.</p>
        </div>
        <button type="button" className={secondaryButton} disabled={loading} onClick={() => void load()}>
          {loading ? "Yangilanmoqda…" : "Yangilash"}
        </button>
      </div>

      {notice && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${notice.tone === "error" ? "border-error/30 bg-error/10 text-error" : "border-success/30 bg-success/10 text-success"}`}>
          {notice.text}
        </div>
      )}

      {data && !data.configured && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Serverda <code>TELEGRAM_BOT_TOKEN</code> yo&apos;q — bot ishlamaydi.
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

      {!data ? (
        loading ? <p className="py-10 text-center text-sm text-muted">Yuklanmoqda…</p> : null
      ) : tab === "channels" ? (
        <ChannelsTab data={data} act={act} />
      ) : tab === "inbox" ? (
        <InboxTab data={data} channelName={channelName} act={act} />
      ) : tab === "crosspost" ? (
        <CrossPostTab data={data} channelName={channelName} act={act} />
      ) : (
        <BusinessTab data={data} />
      )}
    </div>
  );
}

type Act = (body: Record<string, unknown>, ok: string) => Promise<boolean>;

function ChannelsTab({ data, act }: { data: Data; act: Act }) {
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);

  const startLink = async () => {
    setLinkError(null);
    const res = await requestJson<{ privateUrl: string }>("/api/integrations/telegram/link-code", { method: "POST" });
    if (res.ok) setLink(res.data.privateUrl);
    else setLinkError(res.error);
  };

  const addUrl = data.botUsername ? `https://t.me/${data.botUsername}?startchannel&admin=post_messages+edit_messages+delete_messages` : null;

  return (
    <div className="space-y-4">
      <div className="panel space-y-3 rounded-xl p-4 text-sm">
        <p className="font-semibold text-foreground">Kanal ulash</p>
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>
            Telegram akkauntingizni bog&apos;lang (kod 10 daqiqa, bir martalik).{" "}
            <button type="button" className={secondaryButton} onClick={() => void startLink()}>
              Kod olish
            </button>
            {link && (
              <a className="ml-2 text-accent underline" href={link} target="_blank" rel="noreferrer">
                Botni ochish
              </a>
            )}
            {linkError && <span className="ml-2 text-error">{linkError}</span>}
          </li>
          <li>
            Botni kanalga admin qiling: xabar joylash, tahrirlash, o&apos;chirish va «Kanal DM&apos;larini boshqarish».{" "}
            {addUrl && (
              <a className="text-accent underline" href={addUrl} target="_blank" rel="noreferrer">
                Kanalga qo&apos;shish
              </a>
            )}
          </li>
          <li>Kommentlar uchun botni kanalning muhokama guruhida ham admin qiling.</li>
        </ol>
        <p className="text-xs text-muted">Botni bog&apos;lanmagan odam qo&apos;shsa, bot kanaldan o&apos;zi chiqib ketadi.</p>
      </div>

      {data.channels.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Hali kanal ulanmagan.</p>
      ) : (
        data.channels.map((channel) => (
          <div key={channel.id} className="panel space-y-2 rounded-xl p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words font-semibold text-foreground">{channel.title ?? channel.chatId}</p>
                <p className="text-xs text-muted">{channel.username ? `@${channel.username}` : channel.chatId}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={channel.status === "ACTIVE" ? "success" : channel.status === "MISSING_RIGHTS" ? "warning" : "muted"}>
                  {channel.status === "ACTIVE" ? "Ulangan" : channel.status === "MISSING_RIGHTS" ? "Huquq yetishmaydi" : "Uzilgan"}
                </Pill>
                <Pill tone={channel.discussionReady ? "success" : "muted"}>{channel.linkedChatId ? (channel.discussionReady ? "Kommentlar" : "Guruhda admin emas") : "Muhokama yo'q"}</Pill>
                <Pill tone={channel.dmChatId ? "success" : "muted"}>{channel.dmChatId ? "DM" : "DM hali yo'q"}</Pill>
              </div>
            </div>
            {channel.missingRights.length > 0 && channel.status !== "REMOVED" && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                Botga yetishmayotgan huquqlar: {channel.missingRights.map((r) => data.rightLabels[r] ?? r).join(", ")}
              </div>
            )}
            {channel.status !== "REMOVED" && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondaryButton} onClick={() => void act({ action: "recheck", id: channel.id }, "Qayta tekshirildi")}>
                  Tekshirish
                </button>
                <button type="button" className={secondaryButton} onClick={() => void act({ action: "disconnect", id: channel.id }, "Kanal uzildi")}>
                  Uzish
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function InboxTab({ data, channelName, act }: { data: Data; channelName: (id: string) => string; act: Act }) {
  const [kind, setKind] = useState<"" | InboxMessage["kind"]>("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [text, setText] = useState("");
  const rows = data.inbox.filter((m) => !kind || m.kind === kind);

  const send = async () => {
    if (!replyTo || !text.trim()) return;
    if (await act({ action: "reply", id: replyTo, text }, "Javob yuborildi")) {
      setReplyTo(null);
      setText("");
    }
  };

  return (
    <div className="space-y-3">
      <select className={`${inputClass} w-auto`} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Turi">
        <option value="">Hammasi</option>
        <option value="comment">Kommentlar</option>
        <option value="channel_dm">Kanal DM</option>
        <option value="business_dm">Business</option>
      </select>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Xabar yo&apos;q.</p>
      ) : (
        rows.map((m) => (
          <div key={m.id} className={`panel space-y-2 rounded-xl p-3 text-sm ${m.direction === "OUT" ? "opacity-70" : ""}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <Pill tone="muted">{KIND_LABEL[m.kind]}</Pill>
              <span className="break-words">{channelName(m.accountRef)}</span>
              <span>·</span>
              <span>{m.direction === "OUT" ? "Biz" : m.authorName ?? "Mijoz"}</span>
              <span>·</span>
              <span>{when(m.createdAt)}</span>
              {m.editedAt && <span>(tahrirlangan)</span>}
              {m.deletedAt && <Pill tone="error">O&apos;chirilgan</Pill>}
            </div>
            <p className="whitespace-pre-wrap break-words text-foreground">{m.text || "(media)"}</p>
            {m.direction === "IN" && !m.deletedAt && (
              replyTo === m.id ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <textarea className={inputClass} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Javob…" maxLength={4096} />
                  <div className="flex gap-2">
                    <button type="button" className={primaryButton} disabled={!text.trim()} onClick={() => void send()}>
                      Yuborish
                    </button>
                    <button type="button" className={secondaryButton} onClick={() => setReplyTo(null)}>
                      Bekor
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className={secondaryButton} onClick={() => { setReplyTo(m.id); setText(""); }}>
                  Javob berish
                </button>
              )
            )}
          </div>
        ))
      )}
    </div>
  );
}

function CrossPostTab({ data, channelName, act }: { data: Data; channelName: (id: string) => string; act: Act }) {
  const live = data.channels.filter((c) => c.status !== "REMOVED");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const toggle = (post: PostRow, channelId: string) => {
    const current = post.targets.filter((t) => t.status !== "DELETED").map((t) => t.accountRef);
    const next = current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId];
    void act({ action: "set_targets", postId: post.id, channelIds: next }, "Saqlandi");
  };

  if (live.length === 0) return <p className="py-6 text-center text-sm text-muted">Avval kanal ulang.</p>;
  if (data.posts.length === 0) return <p className="py-6 text-center text-sm text-muted">Oxirgi 7 kun va kelgusi postlar yo&apos;q.</p>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">Post o&apos;z vaqtida tanlangan kanallarga ham chiqadi (Instagram natijasidan qat&apos;i nazar). Story chiqmaydi.</p>
      {data.posts.map((post) => (
        <div key={post.id} className="panel space-y-2 rounded-xl p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Pill tone="muted">{post.type}</Pill>
            <span>{post.status}</span>
            <span>·</span>
            <span>{when(post.scheduledAt)}</span>
          </div>
          <p className="line-clamp-2 break-words text-foreground">{post.caption || "(matnsiz)"}</p>
          <div className="flex flex-wrap gap-2">
            {live.map((channel) => {
              const target = post.targets.find((t) => t.accountRef === channel.id && t.status !== "DELETED");
              const locked = target && (target.status === "PUBLISHED" || target.status === "PUBLISHING");
              return (
                <label key={channel.id} className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={Boolean(target)} disabled={Boolean(locked)} onChange={() => toggle(post, channel.id)} />
                  {channelName(channel.id)}
                  {target && <Pill tone={TARGET_TONE[target.status]}>{target.status}</Pill>}
                </label>
              );
            })}
          </div>
          {post.targets
            .filter((t) => t.lastError && t.status === "FAILED")
            .map((t) => (
              <p key={t.id} className="text-xs text-error">
                {channelName(t.accountRef)}: {t.lastError}
              </p>
            ))}
          {post.targets
            .filter((t) => t.status === "PUBLISHED")
            .map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">{channelName(t.accountRef)}:</span>
                {editing?.id === t.id ? (
                  <>
                    <textarea className={inputClass} rows={2} value={editing.text} onChange={(e) => setEditing({ id: t.id, text: e.target.value })} />
                    <button type="button" className={primaryButton} onClick={() => void act({ action: "edit_post", id: t.id, text: editing.text }, "Tahrirlandi").then((ok) => ok && setEditing(null))}>
                      Saqlash
                    </button>
                  </>
                ) : (
                  <button type="button" className={secondaryButton} onClick={() => setEditing({ id: t.id, text: post.caption ?? "" })}>
                    Tahrirlash
                  </button>
                )}
                <button type="button" className={secondaryButton} onClick={() => void act({ action: "delete_post", id: t.id }, "Telegram'dan o'chirildi")}>
                  O&apos;chirish
                </button>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function BusinessTab({ data }: { data: Data }) {
  return (
    <div className="space-y-3">
      <div className="panel rounded-xl p-4 text-sm text-muted">
        Telegram → Sozlamalar → Telegram Business → Chatbotlar: <b>@{data.botUsername ?? "bot"}</b> ni qo&apos;shing va «Javob berish» huquqini yoqing. Avval akkauntingizni
        «Kanallar» bo&apos;limidagi kod bilan bog&apos;lang.
      </div>
      {data.business.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Business ulanish yo&apos;q.</p>
      ) : (
        data.business.map((b) => (
          <div key={b.id} className="panel flex flex-wrap items-center justify-between gap-2 rounded-xl p-3 text-sm">
            <span className="text-foreground">Telegram user {b.tgUserId}</span>
            <div className="flex gap-2">
              <Pill tone={b.isEnabled ? "success" : "muted"}>{b.isEnabled ? "Yoqilgan" : "O'chirilgan"}</Pill>
              <Pill tone={b.canReply ? "success" : "warning"}>{b.canReply ? "Javob bera oladi" : "Faqat o'qiydi"}</Pill>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
