"use client";

/**
 * Auto-replies of Facebook, Threads and YouTube: keyword rules with fixed
 * reply variants or an AI reply from the knowledge base, plus the latest
 * replies that went out. The runtime is lib/channels/auto-reply.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, inputClass } from "@/components/assistant-ui";
import { Card, EmptyState, Label } from "@/components/ui/page";
import { CHANNEL_NAME, FlashNotice, formatDateTime, type ChannelKey } from "@/components/channels/ui";
import type { Flash } from "@/lib/flash";
import { jsonInit, requestJson } from "@/lib/request-json";

interface Rule {
  id: string;
  channel: ChannelKey;
  credentialId: string | null;
  name: string;
  enabled: boolean;
  appliesTo: "comment" | "dm" | "both";
  keywords: string[];
  wholeWord: boolean;
  doPublic: boolean;
  doPrivate: boolean;
  publicReplies: string[];
  privateReplies: string[];
  useAi: boolean;
  aiInstruction: string | null;
  priority: number;
  sentCount: number;
  lastFiredAt: string | null;
}

interface LogRow {
  id: string;
  channel: ChannelKey;
  status: "SENDING" | "SENT" | "FAILED";
  actions: string[];
  usedAi: boolean;
  error: string | null;
  createdAt: string;
  message: { text: string; authorName: string | null } | null;
}

interface CredentialLite {
  id: string;
  channel: string;
  externalAccountId: string;
  label: string | null;
  status: string;
}

interface CapsLite {
  supports_dm: boolean;
  private_reply_window_days: number | null;
}

interface Draft {
  id: string | null;
  channel: ChannelKey;
  credentialId: string;
  name: string;
  appliesTo: Rule["appliesTo"];
  keywords: string;
  wholeWord: boolean;
  doPublic: boolean;
  doPrivate: boolean;
  publicReplies: string;
  privateReplies: string;
  useAi: boolean;
  aiInstruction: string;
  priority: number;
}

const ACTION_LABEL: Record<string, string> = { public: "ochiq javob", private: "shaxsiy javob", dm: "xabar" };
const STATUS_TONE: Record<LogRow["status"], "success" | "error" | "muted"> = { SENT: "success", FAILED: "error", SENDING: "muted" };
const STATUS_LABEL: Record<LogRow["status"], string> = { SENT: "Yuborildi", FAILED: "Xato", SENDING: "Yuborilmoqda" };

const blank = (channel: ChannelKey = "facebook"): Draft => ({
  id: null,
  channel,
  credentialId: "",
  name: "",
  appliesTo: "comment",
  keywords: "",
  wholeWord: true,
  doPublic: true,
  doPrivate: false,
  publicReplies: "",
  privateReplies: "",
  useAi: false,
  aiInstruction: "",
  priority: 0,
});

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const words = (text: string) => text.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);

function toDraft(rule: Rule): Draft {
  return {
    id: rule.id,
    channel: rule.channel,
    credentialId: rule.credentialId ?? "",
    name: rule.name,
    appliesTo: rule.appliesTo,
    keywords: rule.keywords.join(", "),
    wholeWord: rule.wholeWord,
    doPublic: rule.doPublic,
    doPrivate: rule.doPrivate,
    publicReplies: rule.publicReplies.join("\n"),
    privateReplies: rule.privateReplies.join("\n"),
    useAi: rule.useAi,
    aiInstruction: rule.aiInstruction ?? "",
    priority: rule.priority,
  };
}

export function AutoRepliesTab({ credentials, caps, canManage, accountName }: { credentials: CredentialLite[]; caps: Record<string, CapsLite>; canManage: boolean; accountName: (id: string) => string }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [log, setLog] = useState<LogRow[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Flash | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const res = await requestJson<{ rules: Rule[]; log: LogRow[] }>("/api/channels/auto-replies");
    if (mine !== seq.current) return;
    if (res.ok) {
      setRules(res.data.rules);
      setLog(res.data.log);
    } else {
      setNotice({ tone: "error", text: res.error });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);

  const send = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    setNotice(null);
    const res = await requestJson("/api/channels/auto-replies", jsonInit("POST", body));
    setBusy(false);
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load();
    return res.ok;
  };

  const save = async () => {
    if (!draft) return;
    const rule = {
      channel: draft.channel,
      credentialId: draft.credentialId || null,
      name: draft.name,
      appliesTo: draft.appliesTo,
      keywords: words(draft.keywords),
      wholeWord: draft.wholeWord,
      doPublic: draft.doPublic,
      doPrivate: draft.doPrivate,
      publicReplies: lines(draft.publicReplies),
      privateReplies: lines(draft.privateReplies),
      useAi: draft.useAi,
      aiInstruction: draft.aiInstruction.trim() || null,
      priority: draft.priority,
    };
    const ok = await send(draft.id ? { action: "update", id: draft.id, rule } : { action: "create", rule }, "Qoida saqlandi");
    if (ok) setDraft(null);
  };

  const channels = (["facebook", "threads", "youtube"] as const).filter((c) => credentials.some((cr) => cr.channel === c && cr.status !== "REVOKED"));

  if (!draft) {
    return (
      <div className="space-y-4">
        <FlashNotice flash={notice} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted">
            Kalit so&apos;z yozilgan komment yoki xabarga o&apos;zi javob beradi. Yangi komment bir daqiqa ichida javob oladi, 6 soatdan eskilari esa faqat qo&apos;lda. Odam allaqachon javob bergan xabarga qayta javob yozilmaydi.
          </p>
          {canManage && (
            <Button disabled={channels.length === 0} onClick={() => setDraft(blank(channels[0]))}>
              Yangi qoida
            </Button>
          )}
        </div>
        {channels.length === 0 && <FlashNotice flash={{ tone: "warning", text: "Avval «Akkauntlar» bo'limida Facebook, Threads yoki YouTube'ni ulang." }} />}

        {rules.length === 0 ? (
          <Card>
            <EmptyState title="Avto-javob qoidalari yo'q" body="Masalan: «narx» so'zi yozilsa — ochiq javob «DM'ga yozdik» va shaxsiy xabarda narxlar ro'yxati." />
          </Card>
        ) : (
          rules.map((rule) => (
            <Card key={rule.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={rule.enabled ? "success" : "muted"}>{rule.enabled ? "Yoqilgan" : "O'chiq"}</Badge>
                <Badge tone="accent">{CHANNEL_NAME[rule.channel]}</Badge>
                {rule.useAi && <Badge tone="accent">AI</Badge>}
                <h3 className="text-[15px] font-medium text-white">{rule.name}</h3>
                <span className="text-xs text-muted">{rule.credentialId ? accountName(rule.credentialId) : "barcha akkauntlar"}</span>
              </div>
              <p className="mt-2 text-sm text-muted">
                {rule.appliesTo === "comment" ? "Kommentlar" : rule.appliesTo === "dm" ? "Xabarlar" : "Kommentlar va xabarlar"} ·{" "}
                {rule.keywords.length > 0 ? `so'zlar: ${rule.keywords.join(", ")}` : "har qanday matn"} · javoblar:{" "}
                {[rule.doPublic && rule.appliesTo !== "dm" ? "ochiq" : null, rule.doPrivate ? "shaxsiy" : null].filter(Boolean).join(" + ")}
              </p>
              <p className="mt-1 text-xs text-muted">
                {rule.sentCount} marta ishlagan{rule.lastFiredAt ? ` · oxirgisi ${formatDateTime(rule.lastFiredAt)}` : ""}
              </p>
              {canManage && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button tone="ghost" disabled={busy} onClick={() => void send({ action: "toggle", id: rule.id, enabled: !rule.enabled }, rule.enabled ? "Qoida o'chirildi" : "Qoida yoqildi")}>
                    {rule.enabled ? "O'chirish" : "Yoqish"}
                  </Button>
                  <Button tone="ghost" disabled={busy} onClick={() => setDraft(toDraft(rule))}>
                    Tahrirlash
                  </Button>
                  <Button tone="ghost" disabled={busy} onClick={() => void send({ action: "delete", id: rule.id }, "Qoida o'chirib tashlandi")}>
                    Olib tashlash
                  </Button>
                </div>
              )}
            </Card>
          ))
        )}

        {log.length > 0 && (
          <Card>
            <Label>So&apos;nggi avto-javoblar</Label>
            <div className="mt-3 space-y-3">
              {log.map((row) => (
                <div key={row.id} className="inset space-y-1 p-3 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
                    <span className="text-muted">{CHANNEL_NAME[row.channel]}</span>
                    {row.actions.length > 0 && <span className="text-muted">· {row.actions.map((a) => ACTION_LABEL[a] ?? a).join(" + ")}</span>}
                    {row.usedAi && <Badge tone="accent">AI</Badge>}
                    <span className="text-muted">· {formatDateTime(row.createdAt)}</span>
                  </div>
                  {row.message && (
                    <p className="line-clamp-2 break-words text-white">
                      {row.message.authorName ? `${row.message.authorName}: ` : ""}
                      {row.message.text}
                    </p>
                  )}
                  {row.error && <p className="break-words text-error">{row.error}</p>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const channelCaps = caps[draft.channel];
  const canDm = !!channelCaps?.supports_dm;
  const canPrivate = canDm || channelCaps?.private_reply_window_days != null;
  const forComments = draft.appliesTo !== "dm";
  const forDms = draft.appliesTo !== "comment";
  const accounts = credentials.filter((c) => c.channel === draft.channel && c.status !== "REVOKED");
  const changeChannel = (channel: ChannelKey) => {
    const next = caps[channel];
    setDraft((d) => (d ? { ...d, channel, credentialId: "", appliesTo: next?.supports_dm ? d.appliesTo : "comment", doPrivate: next?.private_reply_window_days != null || next?.supports_dm ? d.doPrivate : false } : d));
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[15px] font-medium text-white">{draft.id ? "Qoidani tahrirlash" : "Yangi avto-javob qoidasi"}</h3>
        <Button tone="ghost" disabled={busy} onClick={() => setDraft(null)}>
          Bekor qilish
        </Button>
      </div>
      <FlashNotice flash={notice} />

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <Label>Qoida nomi</Label>
          <input className={`${inputClass} mt-2`} value={draft.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="Narx so'rovlari" />
        </div>
        <div>
          <Label>Kanal va akkaunt</Label>
          <div className="mt-2 flex gap-2">
            <select className={inputClass} value={draft.channel} onChange={(e) => changeChannel(e.target.value as ChannelKey)}>
              {channels.map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_NAME[c]}
                </option>
              ))}
            </select>
            <select className={inputClass} value={draft.credentialId} onChange={(e) => set("credentialId", e.target.value)}>
              <option value="">Barcha akkauntlar</option>
              {accounts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label ?? c.externalAccountId}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <Label>Nimaga javob beradi</Label>
          <select className={`${inputClass} mt-2`} value={draft.appliesTo} onChange={(e) => {
              const appliesTo = e.target.value as Draft["appliesTo"];
              setDraft((d) => (d ? { ...d, appliesTo, doPrivate: appliesTo === "comment" ? d.doPrivate : true, doPublic: appliesTo === "dm" ? false : d.doPublic } : d));
            }}>
            <option value="comment">Kommentlarga</option>
            {canDm && <option value="dm">Shaxsiy xabarlarga (Messenger)</option>}
            {canDm && <option value="both">Ikkalasiga ham</option>}
          </select>
          {!canDm && <p className="mt-1 text-xs text-muted">{CHANNEL_NAME[draft.channel]} da shaxsiy xabar yo&apos;q, faqat kommentlarga javob beriladi.</p>}
        </div>
        <div>
          <Label>Kalit so&apos;zlar</Label>
          <input className={`${inputClass} mt-2`} value={draft.keywords} onChange={(e) => set("keywords", e.target.value)} placeholder="narx, qancha, price (bo'sh = har qanday matn)" />
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={draft.wholeWord} onChange={(e) => set("wholeWord", e.target.checked)} /> To&apos;liq so&apos;z (&laquo;narx&raquo; &laquo;narxlar&raquo; ga mos kelmaydi)
          </label>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {forComments && (
          <div>
            <label className="flex items-center gap-2 text-sm text-white">
              <input type="checkbox" checked={draft.doPublic} onChange={(e) => set("doPublic", e.target.checked)} /> Kommentga ochiq javob
            </label>
            {draft.doPublic && (
              <textarea className={`${inputClass} mt-2 min-h-24`} value={draft.publicReplies} onChange={(e) => set("publicReplies", e.target.value)} placeholder={"Har bir qatorda bitta variant. {name} — mijoz ismi.\n{name}, shaxsiy xabarda yozdik!\nRahmat, {name}! DM'ni tekshiring."} />
            )}
          </div>
        )}
        {canPrivate && (
          <div>
            <label className="flex items-center gap-2 text-sm text-white">
              <input type="checkbox" checked={draft.doPrivate} onChange={(e) => set("doPrivate", e.target.checked || forDms)} disabled={forDms} />
              {forDms ? "Shaxsiy xabarga javob" : "Komment egasiga shaxsiy xabar"}
            </label>
            {forComments && channelCaps?.private_reply_window_days != null && <p className="mt-1 text-xs text-muted">Har bir kommentga bir marta va {channelCaps.private_reply_window_days} kun ichida yuboriladi.</p>}
            {(draft.doPrivate || forDms) && (
              <textarea className={`${inputClass} mt-2 min-h-24`} value={draft.privateReplies} onChange={(e) => set("privateReplies", e.target.value)} placeholder={"Har bir qatorda bitta variant.\nSalom, {name}! Narxlar: …"} />
            )}
          </div>
        )}
      </div>

      <div className="inset mt-5 space-y-3 p-4">
        <label className="flex items-center gap-2 text-sm text-white">
          <input type="checkbox" checked={draft.useAi} onChange={(e) => set("useAi", e.target.checked)} /> AI bilan javob yozish (bilim bazasidan)
        </label>
        <p className="text-xs text-muted">
          AI faqat JavobAI bilim bazasidagi ma&apos;lumotdan foydalanadi. Bazada yo&apos;q narx, raqam yoki havola chiqsa, AI javobi yuborilmaydi va yuqoridagi tayyor variantlar ishlatiladi. Ochiq javob uchun tayyor variant yozilgan bo&apos;lsa, AI faqat shaxsiy javobni yozadi.
        </p>
        {draft.useAi && <input className={inputClass} value={draft.aiInstruction} maxLength={500} onChange={(e) => set("aiInstruction", e.target.value)} placeholder="Qo'shimcha ko'rsatma (ixtiyoriy): masalan, «Rasmiy tilda yozing»" />}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-muted">
          Ustuvorlik
          <input type="number" className={`${inputClass} w-20`} min={-100} max={100} value={draft.priority} onChange={(e) => set("priority", Math.max(-100, Math.min(100, Number(e.target.value) || 0)))} />
          <span>(katta raqam birinchi tekshiriladi)</span>
        </label>
        <Button disabled={busy || !draft.name.trim()} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : "Saqlash"}
        </Button>
      </div>
    </Card>
  );
}
