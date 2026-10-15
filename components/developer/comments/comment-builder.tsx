"use client";

/**
 * Comment Automation 2.0 builder. Simple first: every section shows the few
 * choices most campaigns need; matching priority, the fallback text and
 * similar knobs sit folded under "Kengaytirilgan".
 *
 *   1 Manba, akkaunt & postlar   2 Trigger   3 Javoblar   4 Tugma & asosiy xabar
 *   5 Follow-up                  6 Test      7 Eski kommentlar
 *
 * Source "Live efir kommentlari" (ETAP 3, TZ 17) uses the same builder minus
 * what Meta does not allow under a live: no post picker, no public reply and
 * no old-comment scan. Those parts are hidden and the reason is shown.
 *
 * One "Saqlash" writes the campaign and then its child lists (variants,
 * quick replies, follow-ups) through their own endpoints. The form remembers
 * what was last saved, so unsaved changes are always visible.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  buttonTemplateTooLong,
  COMMENT_LIMITS as L,
  MATCHING_MODES,
  privateReplyLimit,
  REPLY_MODES,
} from "@/lib/triggers/comment-limits";
import { Choice, ChipInput, Field, inputClass, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import BacktrackSection from "./backtrack-section";
import FollowUpsEditor, { type FollowUpItem } from "./follow-ups-editor";
import MediaPicker from "./media-picker";
import { Advanced, CharCount, Notice, Section } from "./parts";
import QuickRepliesEditor, { type QuickReplyItem } from "./quick-replies-editor";
import {
  jsonInit,
  MATCH_MODE_TEXT,
  QUICK_REPLY_ACTION_TEXT,
  REPLY_MODE_TEXT,
  requestJson,
  type Account,
  type CommentCampaignView,
  type IntentOption,
  type SavedFollowUpStep,
  type SavedQuickReply,
  type SavedVariant,
} from "./shared";
import SimulatorSection from "./simulator-section";
import VariantsEditor, { type VariantItem } from "./variants-editor";

type Source = CommentCampaignView["triggerType"];

interface FormState {
  name: string;
  source: Source;
  accountId: string;
  mediaScope: "ANY" | "SPECIFIC";
  mediaIds: string[];
  matchingMode: CommentCampaignView["matchingMode"];
  keywords: string[];
  intents: string[];
  priority: number;
  replyMode: CommentCampaignView["replyMode"];
  publicReplyEnabled: boolean;
  buttonOn: boolean;
  buttonLabel: string;
  mainMessage: string;
  stopOnReply: boolean;
  stopOnLead: boolean;
  stopOnHandoff: boolean;
  responseMessage: string;
  active: boolean;
  dmVariants: VariantItem[];
  publicVariants: VariantItem[];
  quickReplies: QuickReplyItem[];
  followUps: FollowUpItem[];
}

const toVariantItem = (v: SavedVariant): VariantItem => ({
  key: v.id,
  id: v.id,
  kind: v.kind,
  text: v.text,
  weight: v.weight,
  source: v.source,
  approved: Boolean(v.approvedAt),
  savedText: v.text,
});
const toQuickReplyItem = (r: SavedQuickReply): QuickReplyItem => ({
  key: r.id,
  id: r.id,
  label: r.label,
  action: r.action,
  responseText: r.responseText ?? "",
});
const toFollowUpItem = (s: SavedFollowUpStep): FollowUpItem => ({
  key: s.id,
  id: s.id,
  delayMinutes: s.delayMinutes,
  condition: s.condition,
  message: s.message,
});

function initialForm(
  campaign: CommentCampaignView | undefined,
  accounts: Account[],
  initialSource: Source = "COMMENT"
): FormState {
  const source = campaign?.triggerType ?? initialSource;
  return {
    name: campaign?.name ?? (source === "LIVE_COMMENT" ? "Live komment → DM" : "Komment → DM"),
    source,
    accountId: campaign?.instagramAccountId ?? accounts[0]?.id ?? "",
    mediaScope: campaign?.mediaScope ?? "ANY",
    mediaIds: campaign?.mediaIds ?? [],
    matchingMode: campaign?.matchingMode ?? "CONTAINS",
    keywords: campaign?.keywords ?? [],
    intents: campaign?.intents ?? [],
    priority: campaign?.priority ?? 0,
    replyMode: campaign?.replyMode ?? "RANDOM",
    publicReplyEnabled: campaign?.publicReplyEnabled ?? false,
    buttonOn: Boolean(campaign?.openingButtonLabel),
    buttonLabel: campaign?.openingButtonLabel ?? "",
    mainMessage: campaign?.mainMessage ?? "",
    stopOnReply: campaign?.stopOnReply ?? true,
    stopOnLead: campaign?.stopOnLead ?? true,
    stopOnHandoff: campaign?.stopOnHandoff ?? true,
    responseMessage: campaign?.responseMessage ?? "",
    active: campaign?.active ?? true,
    dmVariants: (campaign?.variants ?? []).filter((v) => v.kind === "DM").map(toVariantItem),
    publicVariants: (campaign?.variants ?? []).filter((v) => v.kind === "PUBLIC").map(toVariantItem),
    quickReplies: (campaign?.quickReplies ?? []).map(toQuickReplyItem),
    followUps: (campaign?.followUpSteps ?? []).map(toFollowUpItem),
  };
}

/** The DM that goes out when no approved variant exists: typed, else the first approved variant. */
function fallbackText(form: FormState): string {
  return form.responseMessage.trim() || form.dmVariants.find((v) => v.approved && v.text.trim())?.text.trim() || "";
}

/** With the opening button the private reply is a button template (640 chars): what does not fit. */
function overButtonLimit(form: FormState): string | null {
  if (!form.buttonOn) return null;
  const limit = privateReplyLimit(true);
  if (form.dmVariants.some((v) => v.text.trim().length > limit)) return buttonTemplateTooLong("Tugma yoqilganda har bir DM varianti");
  if (fallbackText(form).length > limit) return buttonTemplateTooLong("Tugma yoqilganda zaxira DM matni");
  return null;
}

const isLive = (form: FormState) => form.source === "LIVE_COMMENT";

function campaignBody(form: FormState) {
  const live = isLive(form);
  return {
    name: form.name,
    instagramAccountId: form.accountId,
    triggerType: form.source,
    // A live campaign answers every broadcast of the account: no post picker.
    mediaScope: live ? ("ANY" as const) : form.mediaScope,
    mediaIds: !live && form.mediaScope === "SPECIFIC" ? form.mediaIds : [],
    matchingMode: form.matchingMode,
    keywords: form.keywords,
    intents: form.intents,
    priority: form.priority,
    replyMode: form.replyMode,
    publicReplyEnabled: live ? false : form.publicReplyEnabled,
    openingButtonLabel: form.buttonOn ? form.buttonLabel : null,
    mainMessage: form.buttonOn ? form.mainMessage : null,
    stopOnReply: form.stopOnReply,
    stopOnLead: form.stopOnLead,
    stopOnHandoff: form.stopOnHandoff,
    responseMessage: fallbackText(form),
    active: form.active,
  };
}

function variantsBody(form: FormState) {
  // Live: no public reply, so its variants are not kept either.
  return [...form.dmVariants, ...(isLive(form) ? [] : form.publicVariants)].map((v) => ({
    ...(v.id ? { id: v.id } : {}),
    kind: v.kind,
    text: v.text,
    weight: v.weight,
    source: v.source,
    ...(v.source === "AI" ? { approved: v.approved } : {}),
  }));
}

function quickRepliesBody(form: FormState) {
  if (!form.buttonOn) return [];
  return form.quickReplies.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    label: r.label,
    action: r.action,
    responseText: r.responseText.trim() || null,
  }));
}

function followUpsBody(form: FormState) {
  if (!form.buttonOn) return [];
  return form.followUps.map((s) => ({
    ...(s.id ? { id: s.id } : {}),
    delayMinutes: s.delayMinutes,
    condition: s.condition,
    message: s.message,
  }));
}

function snapshotOf(form: FormState): string {
  return JSON.stringify([campaignBody(form), variantsBody(form), quickRepliesBody(form), followUpsBody(form)]);
}

// ── Preview ──────────────────────────────────────────────────────────────────

function Bubble({ side, label, children }: { side: "left" | "right"; label?: string; children: React.ReactNode }) {
  return (
    <div className={`flex ${side === "left" ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm text-foreground ${
          side === "left" ? "rounded-bl-sm bg-surface-hover" : "rounded-br-sm bg-accent/20"
        }`}
      >
        {label && <span className="mb-1 block text-[10px] text-muted">{label}</span>}
        {children}
      </div>
    </div>
  );
}

function Preview({ form }: { form: FormState }) {
  const sample =
    form.matchingMode === "EVERY" ? "Zo'r! 🔥" : form.keywords[0] ? `${form.keywords[0]}?` : "Narxi qancha?";
  const dm = form.dmVariants.find((v) => v.approved && v.text.trim())?.text ?? fallbackText(form);
  const publicReply = form.publicVariants.find((v) => v.approved && v.text.trim())?.text;
  const live = isLive(form);
  return (
    <div className="panel rounded-xl p-4">
      <p className="label-mono mb-3 text-[11px] font-semibold text-muted">Ko&apos;rinishi</p>
      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">{live ? "Live efirda" : "Post ostida"}</p>
        <Bubble side="left" label="Komment">
          {sample}
        </Bubble>
        {!live && form.publicReplyEnabled && (
          <Bubble side="right" label="Ochiq javob">
            {publicReply || <span className="text-muted">Tasdiqlangan ochiq javob varianti yo&apos;q</span>}
          </Bubble>
        )}
        <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Direct</p>
        <Bubble side="right">
          {dm || <span className="text-muted">DM matni shu yerda ko&apos;rinadi</span>}
          {form.buttonOn && (
            <span className="mt-2 block rounded-lg border border-border bg-surface px-2 py-1 text-center text-xs font-semibold text-accent">
              {form.buttonLabel || "Tugma"}
            </span>
          )}
        </Bubble>
        {form.buttonOn && (
          <>
            <p className="text-center text-[10px] text-muted">— tugma bosildi, 24 soatlik oyna ochildi —</p>
            <Bubble side="right">{form.mainMessage || <span className="text-muted">Asosiy xabar</span>}</Bubble>
            {form.quickReplies.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1">
                {form.quickReplies.map((r) => (
                  <span key={r.key} className="rounded-full border border-accent/40 px-2 py-0.5 text-[11px] text-accent">
                    {r.label || QUICK_REPLY_ACTION_TEXT[r.action]}
                  </span>
                ))}
              </div>
            )}
            {form.followUps.length > 0 && (
              <p className="text-center text-[10px] text-muted">+ {form.followUps.length} ta follow-up</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Builder ──────────────────────────────────────────────────────────────────

export default function CommentBuilder({
  accounts,
  intents,
  campaign,
  initialSource,
}: {
  accounts: Account[];
  intents: IntentOption[];
  campaign?: CommentCampaignView;
  /** New campaign only: preselects the source (the triggers home links here with Live). */
  initialSource?: Source;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => initialForm(campaign, accounts, initialSource));
  // What is stored right now; null until the campaign exists.
  const [savedForm, setSavedForm] = useState<FormState | null>(() =>
    campaign ? initialForm(campaign, accounts) : null
  );
  const [campaignId, setCampaignId] = useState<string | null>(campaign?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const account = accounts.find((a) => a.id === form.accountId);
  const savedSnapshot = useMemo(() => (savedForm ? snapshotOf(savedForm) : null), [savedForm]);
  const dirty = savedSnapshot === null || snapshotOf(form) !== savedSnapshot;
  const intentLabels = useMemo(() => new Map(intents.map((i) => [i.key, i.label])), [intents]);
  const keywordsContext = [
    ...form.keywords,
    ...form.intents.map((key) => intentLabels.get(key) ?? key),
  ].join(", ");
  const savedChildren = savedForm ? savedForm.quickReplies.length + savedForm.followUps.length : 0;

  async function approveSaved(item: VariantItem): Promise<string | null> {
    if (!item.id) return null;
    const res = await requestJson(`/api/developer/comments/variants/${item.id}/approve`, jsonInit("POST", { approved: true }));
    if (!res.ok) return res.error;
    // The stored row is approved now: mirror it in the saved copy so it does not read as unsaved.
    const mark = (v: VariantItem) => (v.key === item.key ? { ...v, approved: true } : v);
    setSavedForm((saved) =>
      saved && { ...saved, dmVariants: saved.dmVariants.map(mark), publicVariants: saved.publicVariants.map(mark) }
    );
    return null;
  }

  async function save() {
    const current = form;
    const tooLong = overButtonLimit(current);
    if (tooLong) {
      setError(tooLong);
      return;
    }
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      let id = campaignId;
      const body = campaignBody(current);
      const next: FormState = { ...current, responseMessage: body.responseMessage };
      const putVariants = (campaign: string) =>
        requestJson<{ variants: SavedVariant[] }>(
          `/api/developer/comments/campaigns/${campaign}/variants`,
          jsonInit("PUT", { variants: variantsBody(current) })
        );
      // The server checks DM variants against Meta's 640-character button
      // template whenever the campaign has (or gets) the button. With the
      // button on, the variants go first so the campaign save sees the new
      // ones; with it off, the campaign goes first so the old limit is gone.
      // Removing the button also removes quick replies and follow-ups on the
      // server, in the same transaction as the campaign.
      let variants: Awaited<ReturnType<typeof putVariants>> | null = null;
      if (!id) {
        const res = await requestJson<{ campaign: { id: string } }>("/api/developer/comments/campaigns", jsonInit("POST", body));
        if (!res.ok) {
          setError(res.error);
          return;
        }
        id = res.data.campaign.id;
        setCampaignId(id);
      } else {
        // Live refuses public variants on both sides: going to Live the
        // variants (now DM only) go first; leaving Live with new public
        // variants the campaign goes first, so it is a post campaign by then.
        const leavingLiveWithPublic =
          savedForm?.source === "LIVE_COMMENT" && !isLive(current) && current.publicVariants.length > 0;
        if (isLive(current) || (current.buttonOn && !leavingLiveWithPublic)) {
          variants = await putVariants(id);
          if (!variants.ok) {
            setError(`Saqlanmadi: ${variants.error}`);
            return;
          }
        }
        const res = await requestJson(`/api/developer/comments/campaigns/${id}`, jsonInit("PATCH", body));
        if (!res.ok) {
          setError(variants ? `Variantlar saqlandi, lekin kampaniya saqlanmadi: ${res.error}` : res.error);
          return;
        }
      }

      variants ??= await putVariants(id);
      if (!variants.ok) {
        setError(`Kampaniya saqlandi, lekin variantlar saqlanmadi: ${variants.error}`);
        return;
      }
      next.dmVariants = variants.data.variants.filter((v) => v.kind === "DM").map(toVariantItem);
      next.publicVariants = variants.data.variants.filter((v) => v.kind === "PUBLIC").map(toVariantItem);

      if (current.buttonOn) {
        const replies = await requestJson<{ quickReplies: SavedQuickReply[] }>(
          `/api/developer/comments/campaigns/${id}/quick-replies`,
          jsonInit("PUT", { quickReplies: quickRepliesBody(current) })
        );
        if (!replies.ok) {
          setError(`Kampaniya saqlandi, lekin quick replylar saqlanmadi: ${replies.error}`);
          return;
        }
        next.quickReplies = replies.data.quickReplies.map(toQuickReplyItem);
        const steps = await requestJson<{ steps: SavedFollowUpStep[] }>(
          `/api/developer/comments/campaigns/${id}/follow-ups`,
          jsonInit("PUT", { steps: followUpsBody(current) })
        );
        if (!steps.ok) {
          setError(`Kampaniya saqlandi, lekin follow-uplar saqlanmadi: ${steps.error}`);
          return;
        }
        next.followUps = steps.data.steps.map(toFollowUpItem);
      } else {
        next.quickReplies = [];
        next.followUps = [];
      }

      setForm(next);
      setSavedForm(next);
      if (!campaignId) {
        router.replace(`/developer/comments/${id}`);
      } else {
        setNote("Saqlandi");
        router.refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="panel rounded-xl p-6 text-sm text-muted">
        Avval Instagram akkaunt ulang:{" "}
        <Link className="text-accent" href="/developer/foundation">
          Foundation → Ulanishlar
        </Link>
        .
      </div>
    );
  }

  const noApprovedDm = !form.dmVariants.some((v) => v.approved && v.text.trim());
  const dmLimit = privateReplyLimit(form.buttonOn);
  const tooLongForButton = overButtonLimit(form);
  const noApprovedPublic = !form.publicVariants.some((v) => v.approved && v.text.trim());
  const live = isLive(form);
  const savedPublic = savedForm ? savedForm.publicVariants.length : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-5">
        <Section
          index={1}
          title={live ? "Manba & akkaunt" : "Manba, akkaunt & postlar"}
          description={
            live
              ? "Qaysi akkauntning live efirlaridagi kommentlarga javob beriladi."
              : "Qaysi akkauntning qaysi postlaridagi kommentlarga javob beriladi."
          }
        >
          <Field label="Manba">
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice
                checked={!live}
                onSelect={() => set({ source: "COMMENT" })}
                title="Post kommentlari"
                description="Post va reelslar ostidagi kommentlar"
              />
              <Choice
                checked={live}
                onSelect={() => set({ source: "LIVE_COMMENT", publicReplyEnabled: false, mediaScope: "ANY" })}
                title="Live efir kommentlari"
                description="Jonli efir paytida yozilgan kommentlar"
              />
            </div>
          </Field>
          {live && (
            <Notice tone="info">
              Meta qoidasi: live kommentga shaxsiy javob <b>faqat efir davom etayotganda</b> va har bir odamga{" "}
              <b>bitta</b> yuboriladi. Efir tugagach javob ketmaydi (logda sababi bilan ko&apos;rinadi). Live&apos;da ochiq
              javob va eski kommentlarni skanerlash yo&apos;q.
            </Notice>
          )}
          {live && savedPublic > 0 && (
            <Notice tone="warning">
              Saqlangan {savedPublic} ta ochiq javob varianti Live&apos;ga o&apos;tganda o&apos;chiriladi.
            </Notice>
          )}
          <Field label="Kampaniya nomi">
            <input
              className={inputClass}
              value={form.name}
              maxLength={L.nameLength}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field
            label="Instagram akkaunt"
            error={
              account?.tokenStatus === "BROKEN"
                ? "Bu akkaunt ulanishi uzilgan — javoblar yuborilmaydi. Foundation bo'limida qayta ulang."
                : null
            }
          >
            <select className={inputClass} value={form.accountId} onChange={(e) => set({ accountId: e.target.value, mediaIds: [] })}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.tokenStatus === "BROKEN" ? " (uzilgan)" : ""}
                </option>
              ))}
            </select>
          </Field>
          {!live && (
            <div className="grid gap-2 sm:grid-cols-2">
              <Choice
                checked={form.mediaScope === "ANY"}
                onSelect={() => set({ mediaScope: "ANY" })}
                title="Har qanday post"
                description="Barcha post va reelslardagi kommentlar"
              />
              <Choice
                checked={form.mediaScope === "SPECIFIC"}
                onSelect={() => set({ mediaScope: "SPECIFIC" })}
                title="Faqat tanlangan postlar"
                description="Bir yoki bir nechta post"
              />
            </div>
          )}
          {!live && form.mediaScope === "SPECIFIC" && (
            <MediaPicker accountId={form.accountId} selected={form.mediaIds} onChange={(mediaIds) => set({ mediaIds })} />
          )}
        </Section>

        <Section index={2} title="Trigger" description="Qanday kommentga javob beriladi. Katta-kichik harf, lotin/kirill farqi yo'q.">
          <div className="grid gap-2 sm:grid-cols-3">
            {MATCHING_MODES.map((mode) => (
              <Choice
                key={mode}
                checked={form.matchingMode === mode}
                onSelect={() => set({ matchingMode: mode })}
                title={MATCH_MODE_TEXT[mode].title}
                description={MATCH_MODE_TEXT[mode].description}
              />
            ))}
          </div>
          {form.matchingMode !== "EVERY" && (
            <>
              <Field
                label={`Kalit so'zlar (${form.keywords.length}/${L.keywords})`}
                hint="Vergul yoki Enter bilan ajrating. “narx” yozsangiz “нарх”, “NARXI” ham ushlanadi."
              >
                <ChipInput
                  values={form.keywords}
                  onChange={(keywords) => set({ keywords: keywords.map((k) => k.slice(0, L.keywordLength)) })}
                  placeholder="narx, цена, info…"
                  max={L.keywords}
                />
              </Field>
              {intents.length > 0 && (
                <Field label="Tayyor intentlar" hint="Bir ma'noli so'zlar to'plami: o'zbek (lotin/kirill) va rus variantlari bilan.">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {intents.map((intent) => {
                      const on = form.intents.includes(intent.key);
                      return (
                        <button
                          key={intent.key}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            set({ intents: on ? form.intents.filter((k) => k !== intent.key) : [...form.intents, intent.key] })
                          }
                          className={`rounded-lg border px-3 py-2 text-left ${
                            on ? "border-accent bg-accent/5" : "border-border hover:border-border-hover"
                          }`}
                        >
                          <span className="flex items-center justify-between gap-2 text-sm font-medium text-foreground">
                            {intent.label}
                            <span
                              aria-hidden="true"
                              className={`grid h-4 w-4 shrink-0 place-items-center rounded border text-[10px] ${
                                on ? "border-accent bg-accent text-background" : "border-border-hover"
                              }`}
                            >
                              {on ? "✓" : ""}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-muted">{intent.examples.slice(0, 5).join(", ")}</span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}
            </>
          )}
          <Advanced>
            <Field
              label="Prioritet"
              hint="Bir nechta kampaniya mos kelsa: aniq kalit so'z → kalit so'z bor → intent → har bir komment; keyin tanlangan post → har qanday post; keyin shu raqam (kattasi yutadi)."
            >
              <input
                type="number"
                min={L.priorityMin}
                max={L.priorityMax}
                className={`${inputClass} w-32`}
                value={form.priority}
                onChange={(e) => set({ priority: Math.round(Number(e.target.value) || 0) })}
              />
            </Field>
          </Advanced>
        </Section>

        <Section index={3} title="Javoblar" description="Bir xil matn takrorlanmasligi uchun 3–10 ta variant. Faqat tasdiqlangan variantlar yuboriladi.">
          <Field label="Direct (shaxsiy) javob variantlari">
            <VariantsEditor
              kind="DM"
              items={form.dmVariants}
              onChange={(dmVariants) => set({ dmVariants })}
              replyMode={form.replyMode}
              defaultGoal={`${form.name}: kommentga Direct'da javob berish`}
              keywordsContext={keywordsContext}
              onApproveSaved={approveSaved}
              maxLength={dmLimit}
            />
          </Field>
          {form.buttonOn && (
            <p className="text-xs text-muted">
              Tugma yoqilgan: DM tugmali shablon bilan ketadi, Meta uning matnini {L.buttonTemplateTextLength} belgi bilan
              cheklaydi.
            </p>
          )}
          {form.dmVariants.length > 1 && (
            <Field label="Variant tanlash usuli">
              <div className="grid gap-2 sm:grid-cols-3">
                {REPLY_MODES.map((mode) => (
                  <Choice
                    key={mode}
                    checked={form.replyMode === mode}
                    onSelect={() => set({ replyMode: mode })}
                    title={REPLY_MODE_TEXT[mode].title}
                    description={REPLY_MODE_TEXT[mode].description}
                  />
                ))}
              </div>
            </Field>
          )}

          {!live && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-foreground">Kommentga ochiq javob ham yozish</p>
                <p className="text-xs text-muted">Masalan: “Direct&apos;ga yubordik 📩”. Narx yozilmaydi.</p>
              </div>
              <Toggle on={form.publicReplyEnabled} onChange={(on) => set({ publicReplyEnabled: on })} label="Ochiq javob" />
            </div>
          )}
          {!live && form.publicReplyEnabled && (
            <>
              {noApprovedPublic && (
                <Notice tone="warning">Ochiq javob yoqilgan, lekin tasdiqlangan variant yo&apos;q — ochiq javob yozilmaydi.</Notice>
              )}
              <VariantsEditor
                kind="PUBLIC"
                items={form.publicVariants}
                onChange={(publicVariants) => set({ publicVariants })}
                replyMode={form.replyMode}
                defaultGoal={`${form.name}: kommentga qisqa ochiq javob, batafsil Direct'da`}
                keywordsContext={keywordsContext}
                onApproveSaved={approveSaved}
              />
            </>
          )}

          <Advanced label="Kengaytirilgan · zaxira matn">
            <Field
              label="Zaxira DM matni"
              hint={
                form.responseMessage.trim()
                  ? "Tasdiqlangan DM varianti bo'lmasa shu yuboriladi."
                  : "Bo'sh qolsa, 1-tasdiqlangan variant zaxira sifatida saqlanadi."
              }
            >
              <textarea
                className={`${inputClass} min-h-20`}
                value={form.responseMessage}
                maxLength={L.messageLength}
                onChange={(e) => set({ responseMessage: e.target.value })}
              />
              <CharCount value={form.responseMessage} max={dmLimit} />
            </Field>
          </Advanced>
          {noApprovedDm && !form.responseMessage.trim() && (
            <Notice tone="warning">Kamida bitta DM variant yozing — aks holda kommentga javob ketmaydi.</Notice>
          )}
        </Section>

        <Section index={4} title="Tugma & asosiy xabar" description="Suhbatni davom ettirish uchun.">
          <Notice tone="info">
            Meta qoidasi: kommentga faqat <b>bitta</b> shaxsiy xabar yuborish mumkin. Davomi (asosiy xabar, quick reply,
            follow-up) odam tugmani bosgandan keyin — 24 soatlik oyna ochilganda yuboriladi.
          </Notice>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">DM&apos;ga tugma qo&apos;shish</p>
              <p className="text-xs text-muted">Masalan: “Narxni ko&apos;rish”, “Katalog”.</p>
            </div>
            <Toggle on={form.buttonOn} onChange={(on) => set({ buttonOn: on })} label="Tugma" />
          </div>
          {tooLongForButton && <Notice tone="warning">{tooLongForButton}</Notice>}
          {!form.buttonOn && savedChildren > 0 && (
            <Notice tone="warning">
              Tugma o&apos;chirilsa, saqlangan quick reply va follow-uplar ham o&apos;chiriladi (ular tugmasiz ishlamaydi).
            </Notice>
          )}
          {form.buttonOn && (
            <>
              <Field label="Tugma nomi">
                <input
                  className={inputClass}
                  value={form.buttonLabel}
                  maxLength={L.buttonLabelLength}
                  onChange={(e) => set({ buttonLabel: e.target.value })}
                  placeholder="Narxni ko'rish"
                />
                <CharCount value={form.buttonLabel} max={L.buttonLabelLength} />
              </Field>
              <Field label="Asosiy xabar (tugma bosilganda)">
                <textarea
                  className={`${inputClass} min-h-24`}
                  value={form.mainMessage}
                  maxLength={L.messageLength}
                  onChange={(e) => set({ mainMessage: e.target.value })}
                  placeholder="Mana katalogimiz: … Qaysi biri qiziq?"
                />
                <CharCount value={form.mainMessage} max={L.messageLength} />
              </Field>
              <Field label="Quick reply tugmalari (ixtiyoriy)" hint="Asosiy xabar ostida chiqadi. Har biri o'z harakatini bajaradi.">
                <QuickRepliesEditor items={form.quickReplies} onChange={(quickReplies) => set({ quickReplies })} />
              </Field>
            </>
          )}
        </Section>

        <Section index={5} title="Follow-up" description="Javob bermaganlarga eslatma.">
          <Notice tone="info">
            Meta&apos;ning 24 soat qoidasi: odam oxirgi marta yozgan (yoki tugmani bosgan) paytdan 24 soat o&apos;tsa, xabar
            yuborib bo&apos;lmaydi. Shuning uchun kechikish ko&apos;pi bilan 23 soat; oyna yopilgan bo&apos;lsa follow-up
            sababi bilan o&apos;tkazib yuboriladi.
          </Notice>
          {!form.buttonOn ? (
            <p className="text-xs text-muted">Follow-up uchun avval 4-bo&apos;limda tugmani yoqing.</p>
          ) : (
            <>
              <FollowUpsEditor items={form.followUps} onChange={(followUps) => set({ followUps })} />
              <div className="space-y-2">
                {(
                  [
                    ["stopOnReply", "Odam yozsa to'xtatish"],
                    ["stopOnLead", "Telefon raqam qoldirsa to'xtatish"],
                    ["stopOnHandoff", "Operatorga o'tkazilsa to'xtatish"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                    <span className="text-sm text-foreground">{label}</span>
                    <Toggle on={form[key]} onChange={(on) => set({ [key]: on })} label={label} />
                  </div>
                ))}
              </div>
            </>
          )}
        </Section>

        <Section index={6} title="Test" description="Komment yozib ko'ring: qaysi kampaniya, nima uchun va qanday javob. Hech narsa yuborilmaydi.">
          <SimulatorSection
            accountId={form.accountId}
            campaignId={campaignId}
            mediaIds={!live && form.mediaScope === "SPECIFIC" ? form.mediaIds : []}
            dirty={dirty}
            active={savedForm?.active ?? true}
            eventType={form.source}
          />
        </Section>

        {!live && (
          <Section index={7} title="Eski kommentlar" description="Kampaniya yaratilishidan oldin yozilgan kommentlarga ham javob yuborish.">
            <BacktrackSection campaignId={campaignId} active={savedForm?.active ?? false} dirty={dirty} />
          </Section>
        )}

        <div className="sticky bottom-0 z-10 -mx-1 space-y-2 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primaryButton} onClick={() => void save()} disabled={saving}>
              {saving ? "Saqlanmoqda…" : campaignId ? "Saqlash" : "Kampaniya yaratish"}
            </button>
            <Link href="/developer/comments" className={secondaryButton}>
              Orqaga
            </Link>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Toggle on={form.active} onChange={(on) => set({ active: on })} label="Faol" />
              {form.active ? "Faol" : "O'chiq"}
            </label>
            <span className={`text-xs ${dirty ? "text-warning" : "text-success"}`} aria-live="polite">
              {dirty ? "Saqlanmagan o'zgarishlar bor" : (note ?? "Hammasi saqlangan")}
            </span>
          </div>
        </div>
      </div>

      <aside className="lg:sticky lg:top-4 lg:self-start">
        <Preview form={form} />
      </aside>
    </div>
  );
}
