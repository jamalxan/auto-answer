"use client";

/**
 * Approval UI (Faza 2, spec §10.5, FR-A1…A5): the composer's "Tasdiqqa
 * yuborish" form, the post detail's review history + notes thread, and the
 * "Tasdiqlar" tab (Mendan kutilmoqda / Yuborganlarim / Rad etilganlar) with
 * bulk approve. Server rules live in lib/content/review.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "@/components/developer/comments/parts";
import { ChipInput, Choice, EmptyState, Field, inputClass, Pill, primaryButton, secondaryButton } from "./ui";
import { CONTENT_API, formatZoned, jsonInit, requestJson, STATUS_LABEL, TYPE_LABEL, type ContentMeta, type PostStatusValue, type PostTypeValue } from "./shared";

// ─── Types (mirror lib/content/review.ts) ──────────────────────────────────

export type ReviewRuleValue = "ANY" | "ALL" | "OPTIONAL";

export interface ReviewerCandidate {
  userId: string;
  label: string;
  email: string | null;
  role: string;
  telegram: boolean;
}

export type MetaWithReviewers = ContentMeta & { reviewers?: ReviewerCandidate[] };

export interface ReviewView {
  id: string;
  reviewerUserId: string | null;
  reviewerLabel: string;
  externalEmail: string | null;
  decision: "APPROVED" | "REJECTED" | null;
  comment: string | null;
  decidedAt: string | null;
  createdAt: string;
  current: boolean;
}

interface ReviewSummary {
  rule: ReviewRuleValue | null;
  submittedAt: string | null;
  status: PostStatusValue;
  reviews: ReviewView[];
}

interface ReviewListItem {
  id: string;
  type: PostTypeValue;
  status: PostStatusValue;
  accountUsername: string | null;
  caption: string | null;
  scheduledAt: string | null;
  timezone: string;
  thumbUrl: string | null;
  rule: ReviewRuleValue | null;
  submittedAt: string | null;
  reviews: ReviewView[];
  myReviewId: string | null;
}

interface NoteView {
  id: string;
  body: string;
  authorId: string;
  authorLabel: string;
  createdAt: string;
}

export interface ReviewDraft {
  reviewerUserIds: string[];
  externalEmails: string[];
  rule: ReviewRuleValue;
}

export const EMPTY_REVIEW: ReviewDraft = { reviewerUserIds: [], externalEmails: [], rule: "ANY" };

export const RULE_LABEL: Record<ReviewRuleValue, { title: string; description: string }> = {
  ANY: { title: "Bittasi yetarli", description: "Birinchi tasdiq bilan post rejalashtiriladi" },
  ALL: { title: "Hammasi tasdiqlasin", description: "Har bir tasdiqlovchi «Tasdiqlash» ni bosishi kerak" },
  OPTIONAL: { title: "Ixtiyoriy", description: "Vaqtigacha hech kim rad etmasa, o'zi chiqadi" },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function reviewDraftIssue(d: ReviewDraft): string | null {
  if (d.reviewerUserIds.length === 0 && d.externalEmails.length === 0) return "Kamida bitta tasdiqlovchini tanlang";
  const bad = d.externalEmails.find((e) => !EMAIL_RE.test(e));
  return bad ? `Email noto'g'ri: ${bad}` : null;
}

function decisionPill(r: ReviewView) {
  if (r.decision === "APPROVED") return <Pill tone="success">Tasdiqladi</Pill>;
  if (r.decision === "REJECTED") return <Pill tone="error">Rad etdi</Pill>;
  return <Pill tone="muted">Kutilmoqda</Pill>;
}

// ─── Composer form ──────────────────────────────────────────────────────────

/** Who reviews and by which rule; the slot comes from the composer's date / time. */
export function ReviewForm({ meta, value, onChange }: { meta: MetaWithReviewers; value: ReviewDraft; onChange: (next: ReviewDraft) => void }) {
  const reviewers = meta.reviewers ?? [];
  const toggle = (id: string) =>
    onChange({ ...value, reviewerUserIds: value.reviewerUserIds.includes(id) ? value.reviewerUserIds.filter((x) => x !== id) : [...value.reviewerUserIds, id] });
  return (
    <div className="space-y-3 inset p-3">
      <p className="text-sm font-semibold">Tasdiqqa yuborish</p>
      <Field label="Tasdiqlovchilar (MANAGER va yuqori)">
        {reviewers.length === 0 ? (
          <span className="text-xs text-muted">Workspace&apos;da tasdiqlovchi yo&apos;q — tashqi email qo&apos;shing.</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {reviewers.map((r) => {
              const on = value.reviewerUserIds.includes(r.userId);
              return (
                <button key={r.userId} type="button" aria-pressed={on} onClick={() => toggle(r.userId)} className={`${secondaryButton} ${on ? "!bg-violet !text-white" : ""}`}>
                  {on ? "✓ " : ""}
                  {r.label}
                  <span className="text-[10px] text-muted">{r.role}{r.telegram ? " · TG" : ""}</span>
                </button>
              );
            })}
          </div>
        )}
      </Field>
      <Field label="Tashqi reviewer (email)" hint="Mijozga 7 kunlik havola yuboriladi">
        <ChipInput values={value.externalEmails} onChange={(externalEmails) => onChange({ ...value, externalEmails: externalEmails.map((e) => e.toLowerCase()) })} placeholder="mijoz@mail.uz" max={10} />
      </Field>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(RULE_LABEL) as ReviewRuleValue[]).map((rule) => (
          <Choice key={rule} checked={value.rule === rule} onSelect={() => onChange({ ...value, rule })} title={RULE_LABEL[rule].title} description={RULE_LABEL[rule].description} />
        ))}
      </div>
    </div>
  );
}

// ─── Decision (approve / reject with a comment) ─────────────────────────────

function DecisionButtons({ postId, onDone }: { postId: string; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && !comment.trim()) return setError("Rad etishda izoh majburiy");
    setBusy(true);
    setError(null);
    const res = await requestJson(`${CONTENT_API}/posts/${postId}/decision`, jsonInit("POST", { decision, comment: comment.trim() || undefined }));
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setRejecting(false);
    setComment("");
    onDone();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={busy} onClick={() => void send("APPROVED")}>
          Tasdiqlash
        </button>
        {!rejecting ? (
          <button type="button" className={`${secondaryButton} text-error`} disabled={busy} onClick={() => setRejecting(true)}>
            Rad etish
          </button>
        ) : (
          <button type="button" className={`${secondaryButton} text-error`} disabled={busy} onClick={() => void send("REJECTED")}>
            Rad etishni yuborish
          </button>
        )}
      </div>
      {rejecting && <textarea className={`${inputClass} min-h-20`} value={comment} maxLength={2000} onChange={(e) => setComment(e.target.value)} placeholder="Nima o'zgarishi kerak? (majburiy)" aria-label="Rad etish izohi" />}
      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}

// ─── Post detail: review history + notes ────────────────────────────────────

export function ReviewHistory({ meta, postId, status, refreshKey, onChanged }: { meta: ContentMeta; postId: string; status: PostStatusValue; refreshKey: number; onChanged: () => void }) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [body, setBody] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const [r, n] = await Promise.all([requestJson<ReviewSummary>(`${CONTENT_API}/posts/${postId}/review`), requestJson<NoteView[]>(`${CONTENT_API}/posts/${postId}/notes`)]);
    if (mine !== seq.current) return;
    if (r.ok) setSummary(r.data);
    if (n.ok) setNotes(n.data);
    setFailure(!r.ok ? r.error : !n.ok ? n.error : null);
  }, [postId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch
    void load();
  }, [load, refreshKey, status]);

  async function addNote() {
    if (!body.trim()) return;
    setBusy(true);
    const res = await requestJson<NoteView>(`${CONTENT_API}/posts/${postId}/notes`, jsonInit("POST", { body }));
    setBusy(false);
    if (!res.ok) return setFailure(res.error);
    setBody("");
    setNotes((list) => [...list, res.data]);
  }

  const current = summary?.reviews.filter((r) => r.current) ?? [];
  const older = summary?.reviews.filter((r) => !r.current) ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 panel rounded-3xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Tasdiqlash</h3>
          {summary?.rule && <Pill tone="muted">{RULE_LABEL[summary.rule].title}</Pill>}
          {summary?.submittedAt && <span className="text-xs text-muted">yuborildi {new Date(summary.submittedAt).toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
        {failure && <Notice tone="error">{failure}</Notice>}
        {summary && summary.reviews.length === 0 && <p className="text-xs text-muted">Bu post hali tasdiqqa yuborilmagan.</p>}
        {current.length > 0 && (
          <ul className="space-y-2">
            {current.map((r) => (
              <li key={r.id} className="rounded-lg bg-background p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">{r.reviewerLabel}</span>
                  {r.externalEmail && <span className="text-muted">tashqi</span>}
                  {decisionPill(r)}
                </div>
                {r.comment && <p className="mt-1 whitespace-pre-wrap text-muted">{r.comment}</p>}
              </li>
            ))}
          </ul>
        )}
        {status === "PENDING_REVIEW" && meta.me.canApprove && <DecisionButtons postId={postId} onDone={() => { void load(); onChanged(); }} />}
        {older.length > 0 && (
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Oldingi tasdiqlar ({older.length}) — post tahrirlangani uchun bekor qilingan</summary>
            <ul className="mt-2 space-y-1">
              {older.map((r) => (
                <li key={r.id}>
                  {r.reviewerLabel}: {r.decision === "APPROVED" ? "tasdiqladi" : r.decision === "REJECTED" ? "rad etdi" : "javob bermadi"}
                  {r.comment ? ` — ${r.comment}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="space-y-3 panel rounded-3xl p-4">
        <h3 className="text-sm font-semibold">Izohlar</h3>
        {notes.length === 0 ? (
          <p className="text-xs text-muted">Hali izoh yo&apos;q.</p>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg bg-background p-2 text-xs">
                <p className="text-muted">
                  <span className="font-semibold text-foreground">{n.authorLabel}</span> · {new Date(n.createdAt).toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
        {meta.me.canCreate && (
          <div className="space-y-2">
            <textarea className={`${inputClass} min-h-16`} value={body} maxLength={2000} onChange={(e) => setBody(e.target.value)} placeholder="Jamoaga izoh…" aria-label="Yangi izoh" />
            <button type="button" className={secondaryButton} disabled={busy || !body.trim()} onClick={() => void addNote()}>
              Izoh qo&apos;shish
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── "Tasdiqlar" tab ────────────────────────────────────────────────────────

const REVIEW_TABS = [
  ["mine", "Mendan kutilmoqda"],
  ["sent", "Yuborganlarim"],
  ["rejected", "Rad etilganlar"],
] as const;
type ReviewTab = (typeof REVIEW_TABS)[number][0];

export function ReviewsPanel({ meta, refreshKey, onOpen, onChanged }: { meta: ContentMeta; refreshKey: number; onOpen: (postId: string) => void; onChanged: () => void }) {
  const [tab, setTab] = useState<ReviewTab>(meta.me.canApprove ? "mine" : "sent");
  const [items, setItems] = useState<ReviewListItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const res = await requestJson<ReviewListItem[]>(`${CONTENT_API}/reviews?tab=${tab}`);
    if (mine !== seq.current) return;
    if (res.ok) {
      setItems(res.data);
      setFailure(null);
    } else setFailure(res.error);
    setSelected(new Set());
  }, [tab]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch
    void load();
  }, [load, refreshKey]);

  async function bulkApprove() {
    setBusy(true);
    const errors: string[] = [];
    for (const id of selected) {
      const res = await requestJson(`${CONTENT_API}/posts/${id}/decision`, jsonInit("POST", { decision: "APPROVED" }));
      if (!res.ok) errors.push(res.error);
    }
    setBusy(false);
    setFailure(errors.length ? `${errors.length} ta post tasdiqlanmadi: ${[...new Set(errors)].join("; ")}` : null);
    onChanged();
    void load();
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Tasdiqlar">
        {REVIEW_TABS.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`${secondaryButton} ${tab === key ? "!bg-violet !text-white" : ""}`}>
            {label}
          </button>
        ))}
        {tab === "mine" && meta.me.canApprove && selected.size > 0 && (
          <button type="button" className={`${primaryButton} ml-auto`} disabled={busy} onClick={() => void bulkApprove()}>
            {busy ? "Tasdiqlanmoqda…" : `Tanlanganlarni tasdiqlash (${selected.size})`}
          </button>
        )}
      </div>
      {failure && <Notice tone="error">{failure}</Notice>}
      {items === null ? (
        <p className="text-sm text-muted">Yuklanmoqda…</p>
      ) : items.length === 0 ? (
        <div className="panel rounded-3xl">
          <EmptyState title={tab === "mine" ? "Sizdan tasdiq kutayotgan post yo'q" : tab === "sent" ? "Siz tasdiqqa post yubormagansiz" : "Rad etilgan post yo'q"} />
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-start gap-3 panel rounded-3xl p-3">
              {tab === "mine" && meta.me.canApprove && (
                <input type="checkbox" className="mt-1" checked={selected.has(item.id)} onChange={() => toggle(item.id)} aria-label="Tanlash" />
              )}
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-background">
                {item.thumbUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                  <img src={item.thumbUrl} alt="" className="h-full w-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{TYPE_LABEL[item.type]} · @{item.accountUsername}</span>
                  <Pill tone={item.status === "REJECTED" ? "error" : item.status === "PENDING_REVIEW" ? "warning" : "muted"}>{STATUS_LABEL[item.status]}</Pill>
                  {item.rule && <span className="text-xs text-muted">{RULE_LABEL[item.rule].title}</span>}
                  {item.scheduledAt && <span className="text-xs text-muted">{formatZoned(new Date(item.scheduledAt), item.timezone)}</span>}
                </div>
                {item.caption && <p className="line-clamp-2 text-xs text-muted">{item.caption}</p>}
                {item.reviews.length > 0 && (
                  <ul className="flex flex-wrap gap-2 text-xs">
                    {item.reviews.map((r) => (
                      <li key={r.id} className="flex items-center gap-1">
                        {r.reviewerLabel} {decisionPill(r)}
                        {r.comment && <span className="text-muted">— {r.comment}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {tab === "mine" && item.myReviewId && meta.me.canApprove && <DecisionButtons postId={item.id} onDone={() => { onChanged(); void load(); }} />}
              </div>
              <button type="button" className={secondaryButton} onClick={() => onOpen(item.id)}>
                Ochish
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
