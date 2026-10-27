"use client";

/**
 * Audit phase 5 — content intelligence, the developer screen. Per account:
 * posts scored against the 30-day median with their business result and the
 * typical-error checks, the weekly report and tag correlations, the two-week
 * plan with Reel scenarios, and Trial Reels hook tests.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { jsonInit, requestJson } from "@/components/developer/comments/shared";
import { DevBadge, inputClass, Pill, primaryButton, secondaryButton } from "@/components/developer/ui";

const API = "/api/developer/content-intel";

interface Analysis {
  status: "PENDING" | "DONE" | "FAILED" | "SKIPPED";
  tags: Record<string, unknown>;
  issues: string[];
  error: string | null;
}

interface Stat {
  id: string;
  permalink: string | null;
  caption: string | null;
  productType: string | null;
  mediaType: string;
  publishedAt: string;
  views: number | null;
  saves: number | null;
  shares: number | null;
  score: number | null;
  scoreLabel: string;
  bizComments: number;
  bizDms: number;
  bizLeads: number;
  bizSales: number;
  analysis: Analysis | null;
}

interface Correlation {
  label: string;
  medianScore: number;
  posts: number;
}

interface ReportBody {
  weekStart: string;
  totals: { posts: number; views: number; comments: number; dms: number; leads: number; sales: number };
  top: Array<{ statId: string; caption: string; scoreLabel: string; leads: number; note: string | null }>;
  bottom: Array<{ statId: string; caption: string; scoreLabel: string }>;
  issues: Array<{ code: string; text: string; posts: number }>;
}

interface Scenario {
  hooks: string[];
  script: Array<{ sec: string; text: string }>;
  shotList: Array<{ shot: string; camera: string }>;
  audio: { tempo: string; voice: string; music: string };
  subtitles: { style: string; keywords: string[] };
  caption: string;
  ctaKeyword: string;
  dmMessage: string;
  upload: { aspect: string; resolution: string; cover: string; firstComment: string; publishAt: string };
}

interface PlanItem {
  key: string;
  date: string;
  time: string;
  format: string;
  topic: string;
  hookIdeas: string[];
  why: string;
  evidence: string[];
  scenario?: Scenario | null;
  draftPostId?: string | null;
}

interface Plan {
  id: string;
  startsOn: string;
  status: string;
  items: PlanItem[];
  createdAt: string;
}

interface Experiment {
  id: string;
  title: string;
  status: string;
  winnerIndex: number | null;
  variants: Array<{ hook: string; postId: string; views?: number | null; dropped?: boolean }>;
}

interface Data {
  accounts: Array<{ id: string; username: string; tokenStatus: string }>;
  account: { id: string; username: string } | null;
  stats: Stat[];
  correlations: Correlation[];
  reports: Array<{ id: string; weekStart: string; body: ReportBody; sentAt: string | null }>;
  currentWeek?: ReportBody;
  plans: Plan[];
  experiments: Experiment[];
  quota: { used: number; limit: number };
  issueText: Record<string, string>;
}

const TABS = [
  ["posts", "Postlar"],
  ["report", "Hisobot"],
  ["plan", "Reja"],
  ["hooks", "Hook test"],
] as const;
type Tab = (typeof TABS)[number][0];

const day = (iso: string) => new Date(iso).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" });

export default function ContentIntelDashboard() {
  const [tab, setTab] = useState<Tab>("posts");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async (account: string | null) => {
    const mine = ++seq.current;
    setLoading(true);
    const res = await requestJson<Data>(account ? `${API}?accountId=${encodeURIComponent(account)}` : API);
    if (mine !== seq.current) return;
    if (res.ok) setData(res.data);
    else setNotice({ tone: "error", text: res.error });
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on account change
    void load(accountId);
  }, [load, accountId]);

  const act = async (body: Record<string, unknown>, ok: string): Promise<unknown> => {
    setBusy(true);
    setNotice(null);
    const res = await requestJson<unknown>(API, jsonInit("POST", { accountId: data?.account?.id, ...body }));
    setBusy(false);
    setNotice(res.ok ? { tone: "success", text: ok } : { tone: "error", text: res.error });
    if (res.ok) await load(data?.account?.id ?? null);
    return res.ok ? res.data : null;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Kontent intellekti</h1>
            <DevBadge />
          </div>
          <p className="mt-1 text-sm text-muted">Har bir post akkauntning 30 kunlik medianasiga nisbatan; video ichidan sabablar; reja va senariy.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data && data.accounts.length > 0 && (
            <select className={`${inputClass} w-auto`} value={data.account?.id ?? ""} onChange={(e) => setAccountId(e.target.value)} aria-label="Akkaunt">
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          )}
          <button type="button" className={secondaryButton} disabled={busy || !data?.account} onClick={() => void act({ action: "collect" }, "Instagram'dan yangilandi")}>
            Instagram&apos;dan yangilash
          </button>
        </div>
      </div>

      {notice && (
        <div className={`rounded-lg border px-3 py-2 text-sm ${notice.tone === "error" ? "border-error/30 bg-error/10 text-error" : "border-success/30 bg-success/10 text-success"}`}>{notice.text}</div>
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
      ) : !data.account ? (
        <p className="py-10 text-center text-sm text-muted">Instagram akkaunt ulanmagan.</p>
      ) : tab === "posts" ? (
        <PostsTab data={data} busy={busy} act={act} />
      ) : tab === "report" ? (
        <ReportTab data={data} />
      ) : tab === "plan" ? (
        <PlanTab data={data} busy={busy} act={act} />
      ) : (
        <HooksTab data={data} busy={busy} act={act} />
      )}
    </div>
  );
}

type Act = (body: Record<string, unknown>, ok: string) => Promise<unknown>;

function scoreTone(score: number | null): "success" | "warning" | "error" | "muted" {
  if (score === null) return "muted";
  if (score >= 1.1) return "success";
  if (score <= 0.9) return "error";
  return "warning";
}

function PostsTab({ data, busy, act }: { data: Data; busy: boolean; act: Act }) {
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">
          Video tahlil: bu oy {data.quota.used}/{data.quota.limit}
        </span>
        <button type="button" className={secondaryButton} disabled={busy || selected.length === 0} onClick={() => void act({ action: "analyze", statIds: selected }, "Tahlil navbatga qo'yildi").then(() => setSelected([]))}>
          Tanlanganlarni tahlil qilish ({selected.length})
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act({ action: "analyze_recent" }, "Oxirgi 30 kun navbatga qo'yildi")}>
          Oxirgi 30 kunni tahlil qilish
        </button>
      </div>
      {data.stats.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">Hali ma&apos;lumot yo&apos;q — «Instagram&apos;dan yangilash» ni bosing.</p>
      ) : (
        data.stats.map((s) => (
          <div key={s.id} className="panel space-y-2 rounded-xl p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} aria-label="Tanlash" disabled={s.analysis?.status === "DONE" || s.analysis?.status === "PENDING"} />
              <span className="text-xs text-muted">{day(s.publishedAt)}</span>
              <Pill tone="muted">{s.productType ?? s.mediaType}</Pill>
              <Pill tone={scoreTone(s.score)}>{s.scoreLabel}</Pill>
              <span className="text-xs text-muted">
                {s.views ?? "—"} ko&apos;rish · {s.saves ?? 0} saqlash · {s.shares ?? 0} ulashish
              </span>
              <span className="text-xs text-foreground">
                {s.bizComments} komment → {s.bizDms} DM → {s.bizLeads} lid → {s.bizSales} sotuv
              </span>
            </div>
            <p className="line-clamp-2 break-words text-foreground">
              {s.permalink ? (
                <a href={s.permalink} target="_blank" rel="noreferrer" className="hover:underline">
                  {s.caption || "(matnsiz)"}
                </a>
              ) : (
                s.caption || "(matnsiz)"
              )}
            </p>
            {s.analysis && (
              <div className="space-y-1 text-xs">
                {s.analysis.status === "PENDING" && <Pill tone="warning">Tahlil navbatda</Pill>}
                {s.analysis.status === "FAILED" && <span className="text-error">Tahlil bo&apos;lmadi: {s.analysis.error}</span>}
                {s.analysis.status === "DONE" && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {["hookType", "format", "topic"].map((k) =>
                        s.analysis!.tags[k] ? (
                          <Pill key={k} tone="muted">
                            {String(s.analysis!.tags[k])}
                          </Pill>
                        ) : null
                      )}
                    </div>
                    {typeof s.analysis.tags.note === "string" && <p className="text-muted">{s.analysis.tags.note}</p>}
                    {s.analysis.issues.length > 0 && (
                      <ul className="list-disc pl-5 text-warning">
                        {s.analysis.issues.map((code) => (
                          <li key={code}>{data.issueText[code] ?? code}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function ReportView({ body, issueText }: { body: ReportBody; issueText: Record<string, string> }) {
  const t = body.totals;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-foreground">
        {t.posts} post · {t.views} ko&apos;rish · {t.comments} komment → {t.dms} DM → {t.leads} lid → {t.sales} sotuv
      </p>
      {body.top.length > 0 && (
        <div>
          <p className="label-mono text-[11px] font-semibold text-muted">Eng yaxshilari</p>
          {body.top.map((p) => (
            <p key={p.statId} className="break-words">
              • {p.caption || "(matnsiz)"} — <span className="text-success">{p.scoreLabel}</span>
              {p.note && <span className="block pl-3 text-xs text-muted">{p.note}</span>}
            </p>
          ))}
        </div>
      )}
      {body.bottom.length > 0 && (
        <div>
          <p className="label-mono text-[11px] font-semibold text-muted">Kuchsizlari</p>
          {body.bottom.map((p) => (
            <p key={p.statId} className="break-words">
              • {p.caption || "(matnsiz)"} — <span className="text-error">{p.scoreLabel}</span>
            </p>
          ))}
        </div>
      )}
      {body.issues.length > 0 && (
        <div>
          <p className="label-mono text-[11px] font-semibold text-muted">Tipik xatolar</p>
          {body.issues.map((i) => (
            <p key={i.code}>
              • {issueText[i.code] ?? i.text} ({i.posts})
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function ReportTab({ data }: { data: Data }) {
  return (
    <div className="space-y-4">
      <div className="panel space-y-2 rounded-xl p-4">
        <p className="font-semibold text-foreground">Nima ishlayapti (teglar → natija, mediana)</p>
        {data.correlations.length === 0 ? (
          <p className="text-sm text-muted">Har bir teg uchun kamida 3 ta tahlil qilingan post kerak.</p>
        ) : (
          data.correlations.map((c) => (
            <p key={c.label} className="text-sm">
              {c.label} — <span className={c.medianScore >= 1 ? "text-success" : "text-error"}>{c.medianScore}×</span> <span className="text-muted">({c.posts} post)</span>
            </p>
          ))
        )}
      </div>
      {data.currentWeek && (
        <div className="panel space-y-2 rounded-xl p-4">
          <p className="font-semibold text-foreground">Shu hafta (hozircha)</p>
          <ReportView body={data.currentWeek} issueText={data.issueText} />
        </div>
      )}
      {data.reports.map((r) => (
        <div key={r.id} className="panel space-y-2 rounded-xl p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-foreground">Hafta: {day(r.weekStart)}</p>
            <Pill tone={r.sentAt ? "success" : "muted"}>{r.sentAt ? "Telegram'ga yuborilgan" : "Saqlangan"}</Pill>
          </div>
          <ReportView body={r.body} issueText={data.issueText} />
        </div>
      ))}
    </div>
  );
}

function ScenarioView({ s }: { s: Scenario }) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-xs">
      <p>
        <b>Hook (0–3 s):</b> {s.hooks.join(" | ")}
      </p>
      <div>
        <b>Senariy:</b>
        {s.script.map((line, i) => (
          <p key={i}>
            {line.sec}s — {line.text}
          </p>
        ))}
      </div>
      <div>
        <b>Shot list:</b>
        {s.shotList.map((shot, i) => (
          <p key={i}>
            {shot.shot} · {shot.camera}
          </p>
        ))}
      </div>
      <p>
        <b>Ovoz va musiqa:</b> {s.audio.tempo}; {s.audio.voice}; {s.audio.music}
      </p>
      <p>
        <b>Subtitr:</b> {s.subtitles.style} — {s.subtitles.keywords.join(", ")}
      </p>
      <p className="whitespace-pre-wrap">
        <b>Caption + CTA:</b> {s.caption}
      </p>
      <p>
        <b>Kampaniya:</b> «{s.ctaKeyword}» → {s.dmMessage}
      </p>
      <p>
        <b>Yuklash:</b> {s.upload.aspect}, {s.upload.resolution}; muqova: {s.upload.cover}; birinchi komment: {s.upload.firstComment}; vaqt: {s.upload.publishAt}
      </p>
    </div>
  );
}

function PlanTab({ data, busy, act }: { data: Data; busy: boolean; act: Act }) {
  const plan = data.plans[0] ?? null;
  return (
    <div className="space-y-3">
      <button type="button" className={primaryButton} disabled={busy} onClick={() => void act({ action: "plan_generate" }, "2 haftalik reja tuzildi")}>
        {busy ? "Tuzilmoqda…" : "2 haftalik reja tuzish"}
      </button>
      {!plan ? (
        <p className="py-6 text-center text-sm text-muted">Reja yo&apos;q.</p>
      ) : (
        plan.items.map((item) => (
          <div key={item.key} className="panel space-y-2 rounded-xl p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-foreground">
                {item.date} {item.time}
              </span>
              <Pill tone="muted">{item.format}</Pill>
              <span className="break-words text-foreground">{item.topic}</span>
            </div>
            {item.hookIdeas.length > 0 && <p className="text-xs text-muted">Hook g&apos;oyalari: {item.hookIdeas.join(" | ")}</p>}
            <p className="text-xs text-muted">Nega: {item.why}</p>
            {item.scenario && <ScenarioView s={item.scenario} />}
            <div className="flex flex-wrap gap-2">
              {item.format === "reel" && (
                <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act({ action: "scenario", planId: plan.id, key: item.key }, "Senariy tayyor")}>
                  {item.scenario ? "Senariyni qayta yozish" : "Senariy yozish"}
                </button>
              )}
              {item.draftPostId ? (
                <a className={secondaryButton} href="/content">
                  Qoralama Content&apos;da
                </a>
              ) : (
                <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act({ action: "plan_draft", planId: plan.id, key: item.key }, "Content Scheduler'da qoralama yaratildi")}>
                  Qoralama yaratish
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function HooksTab({ data, busy, act }: { data: Data; busy: boolean; act: Act }) {
  const [title, setTitle] = useState("");
  const [hooks, setHooks] = useState(["", "", ""]);
  const [caption, setCaption] = useState("");
  const create = async () => {
    const ok = await act({ action: "experiment_create", title, hooks, caption }, "Trial Reels qoralamalari yaratildi — har biriga video qo'shib rejalashtiring");
    if (ok) {
      setTitle("");
      setHooks(["", "", ""]);
      setCaption("");
    }
  };
  return (
    <div className="space-y-4">
      <div className="panel space-y-2 rounded-xl p-4 text-sm">
        <p className="font-semibold text-foreground">Yangi hook testi (Trial Reels)</p>
        <p className="text-xs text-muted">Har bir hook alohida Trial Reel bo&apos;ladi (avval obunachi bo&apos;lmaganlarga). 48 soatdan keyin ko&apos;rishlar bo&apos;yicha g&apos;olib aniqlanadi.</p>
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nomi (masalan: Narx videosi)" />
        {hooks.map((h, i) => (
          <input key={i} className={inputClass} value={h} onChange={(e) => setHooks(hooks.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Hook ${i + 1}${i === 2 ? " (ixtiyoriy)" : ""}`} />
        ))}
        <textarea className={inputClass} rows={2} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Umumiy caption (ixtiyoriy)" />
        <button type="button" className={primaryButton} disabled={busy || hooks.filter((h) => h.trim()).length < 2} onClick={() => void create()}>
          Test yaratish
        </button>
      </div>
      {data.experiments.map((e) => (
        <div key={e.id} className="panel space-y-1 rounded-xl p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-foreground">{e.title}</span>
            <div className="flex items-center gap-2">
              <Pill tone={e.status === "DONE" ? "success" : e.status === "RUNNING" ? "warning" : "muted"}>{e.status}</Pill>
              {e.status === "RUNNING" && (
                <button type="button" className={secondaryButton} disabled={busy} onClick={() => void act({ action: "experiment_cancel", id: e.id }, "Bekor qilindi")}>
                  Bekor
                </button>
              )}
            </div>
          </div>
          {e.variants.map((v, i) => (
            <p key={v.postId} className={v.dropped ? "text-muted line-through" : ""}>
              {e.winnerIndex === i ? "🏆 " : "• "}
              {v.hook} — {v.views ?? "…"} ko&apos;rish
            </p>
          ))}
        </div>
      ))}
    </div>
  );
}
