"use client";

/**
 * ETAP 3 builder for the DM-side triggers: Direct, ad message, ig.me link
 * and Story Mention. Same building blocks as Comment 2.0 (variants with the
 * AI generator, quick replies, follow-ups); simple first, the rarely touched
 * knobs folded under "Kengaytirilgan".
 *
 *   1 Akkaunt & trigger turi   2 Shart   3 Javob   4 Follow-up
 *   5 Kengaytirilgan           6 Test
 *
 * The person wrote first, so Meta's 24-hour window is already open: no
 * opening button, the reply goes out with its quick replies at once and the
 * follow-ups count from it. One "Saqlash" writes the campaign and then its
 * child lists through their own endpoints; unsaved changes are always shown.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AUDIENCE_LABELS, AUTOMATION_KIND_LABELS } from "@/lib/triggers/display";
import {
  AUDIENCES,
  COMMENT_LIMITS as L,
  DM_FOLLOW_UP_CONDITIONS,
  DM_TRIGGER_LIMITS as D,
  MATCHING_MODES,
  REPLY_MODES,
  type Audience,
} from "@/lib/triggers/comment-limits";
import { Choice, ChipInput, Field, inputClass, primaryButton, secondaryButton, Toggle } from "@/components/developer/ui";
import FollowUpsEditor, { type FollowUpItem } from "@/components/developer/comments/follow-ups-editor";
import { Advanced, CharCount, Notice, Section } from "@/components/developer/comments/parts";
import QuickRepliesEditor, { type QuickReplyItem } from "@/components/developer/comments/quick-replies-editor";
import {
  jsonInit,
  QUICK_REPLY_ACTION_TEXT,
  REPLY_MODE_TEXT,
  requestJson,
  type Account,
  type IntentOption,
  type SavedFollowUpStep,
  type SavedQuickReply,
  type SavedVariant,
} from "@/components/developer/comments/shared";
import VariantsEditor, { type VariantItem } from "@/components/developer/comments/variants-editor";
import DmSimulator from "./dm-simulator";
import {
  DM_API,
  DM_KINDS,
  DM_MATCH_MODE_TEXT,
  igMeLink,
  kindToTrigger,
  triggerToKind,
  type DmCampaignView,
  type DmKind,
} from "./shared";

interface FormState {
  name: string;
  accountId: string;
  kind: DmKind;
  matchingMode: DmCampaignView["matchingMode"];
  keywords: string[];
  intents: string[];
  audience: Audience;
  reopenAfterHours: number;
  cooldownHours: number;
  adIds: string[];
  refs: string[];
  priority: number;
  replyMode: DmCampaignView["replyMode"];
  stopOnReply: boolean;
  stopOnLead: boolean;
  stopOnHandoff: boolean;
  responseMessage: string;
  active: boolean;
  variants: VariantItem[];
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

const DEFAULT_NAMES: Record<DmKind, string> = {
  DIRECT: "Direct → javob",
  AD_MESSAGE: "Reklama → javob",
  LINK: "ig.me havola → javob",
  STORY_MENTION: "Story mention → rahmat",
};

function initialForm(campaign: DmCampaignView | undefined, accounts: Account[], initialKind: DmKind): FormState {
  const kind = campaign ? triggerToKind(campaign.triggerType, campaign.sourceFilter) : initialKind;
  return {
    name: campaign?.name ?? DEFAULT_NAMES[kind],
    accountId: campaign?.instagramAccountId ?? accounts[0]?.id ?? "",
    kind,
    matchingMode: campaign?.matchingMode ?? (kind === "DIRECT" ? "CONTAINS" : "EVERY"),
    keywords: campaign?.keywords ?? [],
    intents: campaign?.intents ?? [],
    audience: campaign?.audience ?? "ANY",
    reopenAfterHours: campaign?.reopenAfterHours ?? D.reopenDefaultHours,
    cooldownHours: campaign?.cooldownHours ?? D.cooldownDefaultHours,
    adIds: campaign?.adIds ?? [],
    refs: campaign?.refs ?? [],
    priority: campaign?.priority ?? 0,
    replyMode: campaign?.replyMode ?? "RANDOM",
    stopOnReply: campaign?.stopOnReply ?? true,
    stopOnLead: campaign?.stopOnLead ?? true,
    stopOnHandoff: campaign?.stopOnHandoff ?? true,
    responseMessage: campaign?.responseMessage ?? "",
    active: campaign?.active ?? true,
    variants: (campaign?.variants ?? []).filter((v) => v.kind === "DM").map(toVariantItem),
    quickReplies: (campaign?.quickReplies ?? []).map(toQuickReplyItem),
    followUps: (campaign?.followUpSteps ?? []).map(toFollowUpItem),
  };
}

/** The DM that goes out when no approved variant exists: typed, else the first approved variant. */
function fallbackText(form: FormState): string {
  return form.responseMessage.trim() || form.variants.find((v) => v.approved && v.text.trim())?.text.trim() || "";
}

function campaignBody(form: FormState) {
  const { triggerType, sourceFilter } = kindToTrigger(form.kind);
  const mention = form.kind === "STORY_MENTION";
  return {
    name: form.name,
    instagramAccountId: form.accountId,
    triggerType,
    // Mentions carry no text: always "every mention" (the server enforces it too).
    matchingMode: mention ? "EVERY" : form.matchingMode,
    keywords: mention ? [] : form.keywords,
    intents: mention ? [] : form.intents,
    audience: form.audience,
    reopenAfterHours: form.reopenAfterHours,
    cooldownHours: form.cooldownHours,
    sourceFilter,
    adIds: sourceFilter === "ADS" ? form.adIds : [],
    refs: sourceFilter === "LINK" ? form.refs : [],
    priority: form.priority,
    replyMode: form.replyMode,
    stopOnReply: form.stopOnReply,
    stopOnLead: form.stopOnLead,
    stopOnHandoff: form.stopOnHandoff,
    responseMessage: fallbackText(form),
    active: form.active,
  };
}

function variantsBody(form: FormState) {
  return form.variants.map((v) => ({
    ...(v.id ? { id: v.id } : {}),
    kind: "DM" as const,
    text: v.text,
    weight: v.weight,
    source: v.source,
    ...(v.source === "AI" ? { approved: v.approved } : {}),
  }));
}

function quickRepliesBody(form: FormState) {
  return form.quickReplies.map((r) => ({
    ...(r.id ? { id: r.id } : {}),
    label: r.label,
    action: r.action,
    responseText: r.responseText.trim() || null,
  }));
}

function followUpsBody(form: FormState) {
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

function incoming(form: FormState): { label: string; text: string } {
  if (form.kind === "STORY_MENTION") return { label: "Story mention", text: "📸 Sizni story'sida belgiladi" };
  const text = form.matchingMode === "EVERY" ? "Salom!" : form.keywords[0] ? `${form.keywords[0]}?` : "Narxi qancha?";
  if (form.kind === "AD_MESSAGE") return { label: "Reklamadan keldi", text };
  if (form.kind === "LINK") return { label: `ig.me havola${form.refs[0] ? ` · ref=${form.refs[0]}` : ""}`, text };
  return { label: "Direct", text };
}

function Preview({ form }: { form: FormState }) {
  const msg = incoming(form);
  const reply = form.variants.find((v) => v.approved && v.text.trim())?.text ?? fallbackText(form);
  return (
    <div className="panel rounded-xl p-4">
      <p className="label-mono mb-3 text-[11px] font-semibold text-muted">Ko&apos;rinishi</p>
      <div className="space-y-3">
        <Bubble side="left" label={msg.label}>
          {msg.text}
        </Bubble>
        <Bubble side="right">{reply || <span className="text-muted">Javob matni shu yerda ko&apos;rinadi</span>}</Bubble>
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
          <p className="text-center text-[10px] text-muted">+ {form.followUps.length} ta follow-up (javobdan keyin)</p>
        )}
        <p className="border-t border-border pt-2 text-[10px] text-muted">
          Bir odamga ko&apos;pi bilan {form.cooldownHours} soatda bir marta javob beriladi.
        </p>
      </div>
    </div>
  );
}

// ── Builder ──────────────────────────────────────────────────────────────────

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
      <code className="min-w-0 flex-1 break-all text-foreground">{url}</code>
      <button
        type="button"
        className="shrink-0 text-accent hover:underline"
        onClick={() => {
          void navigator.clipboard?.writeText(url).then(
            () => setCopied(true),
            () => setCopied(false)
          );
        }}
      >
        {copied ? "Nusxalandi" : "Nusxalash"}
      </button>
    </div>
  );
}

export default function DmTriggerBuilder({
  accounts,
  intents,
  campaign,
  initialKind = "DIRECT",
}: {
  accounts: Account[];
  intents: IntentOption[];
  campaign?: DmCampaignView;
  initialKind?: DmKind;
}) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => initialForm(campaign, accounts, initialKind));
  const [savedForm, setSavedForm] = useState<FormState | null>(() =>
    campaign ? initialForm(campaign, accounts, initialKind) : null
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
  const mention = form.kind === "STORY_MENTION";
  const keywordsContext = mention
    ? "story mention"
    : [...form.keywords, ...form.intents.map((key) => intentLabels.get(key) ?? key)].join(", ");

  async function approveSaved(item: VariantItem): Promise<string | null> {
    if (!item.id) return null;
    const res = await requestJson(`${DM_API}/variants/${item.id}/approve`, jsonInit("POST", { approved: true }));
    if (!res.ok) return res.error;
    const mark = (v: VariantItem) => (v.key === item.key ? { ...v, approved: true } : v);
    setSavedForm((saved) => saved && { ...saved, variants: saved.variants.map(mark) });
    return null;
  }

  async function save() {
    const current = form;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      let id = campaignId;
      const body = campaignBody(current);
      const next: FormState = {
        ...current,
        responseMessage: body.responseMessage,
        matchingMode: body.matchingMode as FormState["matchingMode"],
        keywords: body.keywords,
        intents: body.intents,
      };
      if (!id) {
        const res = await requestJson<{ campaign: { id: string } }>(`${DM_API}/campaigns`, jsonInit("POST", body));
        if (!res.ok) {
          setError(res.error);
          return;
        }
        id = res.data.campaign.id;
        setCampaignId(id);
      } else {
        const res = await requestJson(`${DM_API}/campaigns/${id}`, jsonInit("PATCH", body));
        if (!res.ok) {
          setError(res.error);
          return;
        }
      }

      const variants = await requestJson<{ variants: SavedVariant[] }>(
        `${DM_API}/campaigns/${id}/variants`,
        jsonInit("PUT", { variants: variantsBody(current) })
      );
      if (!variants.ok) {
        setError(`Kampaniya saqlandi, lekin variantlar saqlanmadi: ${variants.error}`);
        return;
      }
      next.variants = variants.data.variants.filter((v) => v.kind === "DM").map(toVariantItem);

      const replies = await requestJson<{ quickReplies: SavedQuickReply[] }>(
        `${DM_API}/campaigns/${id}/quick-replies`,
        jsonInit("PUT", { quickReplies: quickRepliesBody(current) })
      );
      if (!replies.ok) {
        setError(`Kampaniya saqlandi, lekin quick replylar saqlanmadi: ${replies.error}`);
        return;
      }
      next.quickReplies = replies.data.quickReplies.map(toQuickReplyItem);

      const steps = await requestJson<{ steps: SavedFollowUpStep[] }>(
        `${DM_API}/campaigns/${id}/follow-ups`,
        jsonInit("PUT", { steps: followUpsBody(current) })
      );
      if (!steps.ok) {
        setError(`Kampaniya saqlandi, lekin follow-uplar saqlanmadi: ${steps.error}`);
        return;
      }
      next.followUps = steps.data.steps.map(toFollowUpItem);

      setForm(next);
      setSavedForm(next);
      if (!campaignId) {
        router.replace(`/developer/triggers/dm/${id}`);
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

  const noApproved = !form.variants.some((v) => v.approved && v.text.trim());

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-5">
        <Section index={1} title="Akkaunt & trigger turi" description="Qaysi akkauntga qanday xabar kelganda javob beriladi.">
          <Field label="Kampaniya nomi">
            <input className={inputClass} value={form.name} maxLength={L.nameLength} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field
            label="Instagram akkaunt"
            error={
              account?.tokenStatus === "BROKEN"
                ? "Bu akkaunt ulanishi uzilgan — javoblar yuborilmaydi. Foundation bo'limida qayta ulang."
                : null
            }
          >
            <select className={inputClass} value={form.accountId} onChange={(e) => set({ accountId: e.target.value })}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.tokenStatus === "BROKEN" ? " (uzilgan)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Trigger turi">
            <div className="grid gap-2 sm:grid-cols-2">
              {DM_KINDS.map((kind) => (
                <Choice
                  key={kind}
                  checked={form.kind === kind}
                  onSelect={() => set({ kind, ...(kind === "STORY_MENTION" ? { matchingMode: "EVERY" as const } : {}) })}
                  title={AUTOMATION_KIND_LABELS[kind].title}
                  description={AUTOMATION_KIND_LABELS[kind].description}
                />
              ))}
            </div>
          </Field>
          {mention && (
            <Notice tone="info">
              Meta qoidasi: mention faqat ochiq akkauntlardan (yoki sizga obuna bo&apos;lgan yopiq akkauntlardan) keladi. Story
              rasmi saqlanmaydi — logda faqat havolasi turadi.
            </Notice>
          )}
        </Section>

        <Section index={2} title="Shart" description="Qachon javob beriladi. Katta-kichik harf, lotin/kirill farqi yo'q.">
          {mention ? (
            <p className="rounded-lg border border-border px-3 py-2.5 text-xs text-muted">
              Story mention&apos;da matn bo&apos;lmaydi, shuning uchun kalit so&apos;z yo&apos;q — har bir mention&apos;ga javob
              beriladi.
            </p>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                {MATCHING_MODES.map((mode) => (
                  <Choice
                    key={mode}
                    checked={form.matchingMode === mode}
                    onSelect={() => set({ matchingMode: mode })}
                    title={DM_MATCH_MODE_TEXT[mode].title}
                    description={DM_MATCH_MODE_TEXT[mode].description}
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
                    <Field
                      label="Tayyor intentlar"
                      hint="Lug'at asosida (AI emas): bir ma'noli so'zlar to'plami, o'zbek (lotin/kirill) va rus variantlari bilan."
                    >
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
            </>
          )}

          {form.kind === "AD_MESSAGE" && (
            <Field
              label={`Reklamalar (${form.adIds.length}/${D.adIds}) — ixtiyoriy`}
              hint="Bo'sh qolsa, istalgan click-to-Direct reklamadan kelgan xabarga javob beriladi."
            >
              <ChipInput
                values={form.adIds}
                onChange={(adIds) => set({ adIds: adIds.map((id) => id.replace(/\s/g, "")) })}
                placeholder="120211234567890"
                max={D.adIds}
              />
              <details className="text-xs text-muted">
                <summary className="cursor-pointer hover:text-foreground">Reklama ID qayerda?</summary>
                <p className="mt-1">
                  Meta Ads Manager → Reklamalar (Ads) bo&apos;limi → kerakli reklama ustiga bosing: ID reklama nomi ostida yoki
                  &quot;Ustunlar → Sozlash&quot; orqali &quot;Ad ID&quot; ustunida ko&apos;rinadi. Faqat raqamlar (15–20 ta). Logdagi
                  &quot;Reklama: …&quot; belgisida ham ko&apos;rasiz.
                </p>
              </details>
            </Field>
          )}

          {form.kind === "LINK" && (
            <Field
              label={`Havola ref'lari (${form.refs.length}/${D.refs}) — ixtiyoriy`}
              hint="Lotin harf, raqam, “_” va “-”. Bo'sh qolsa, ref'li istalgan ig.me havoladan kelgan xabarga javob beriladi."
            >
              <ChipInput
                values={form.refs}
                onChange={(refs) => set({ refs: refs.map((r) => r.slice(0, D.refLength)) })}
                placeholder="promo_oktabr, bio, qr_dokon"
                max={D.refs}
              />
              {account && form.refs.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted">Shu havolalarni tarqating (bio, QR, sayt, boshqa ijtimoiy tarmoq):</p>
                  {form.refs.map((ref) => (
                    <CopyLink key={ref} url={igMeLink(account.username, ref)} />
                  ))}
                </div>
              )}
              {/* Meta: the ref reaches the webhook for a new conversation only when
                  Icebreakers are set; links don't work on Instagram Web. */}
              <p className="rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
                Meta talabi: yangi suhbatda ref faqat akkauntda Icebreakers (tezkor savollar) sozlangan
                bo&apos;lsa keladi. ig.me havola Instagram Web&apos;da ishlamaydi — telefonda oching.
              </p>
            </Field>
          )}

          <Field label="Kimga">
            <div className="grid gap-2 sm:grid-cols-2">
              {AUDIENCES.map((audience) => (
                <Choice
                  key={audience}
                  checked={form.audience === audience}
                  onSelect={() => set({ audience })}
                  title={AUDIENCE_LABELS[audience].title}
                  description={
                    audience === "REOPENED"
                      ? `Oxirgi xabaridan ${form.reopenAfterHours} soatdan ko'p o'tganlar`
                      : AUDIENCE_LABELS[audience].description
                  }
                />
              ))}
            </div>
          </Field>
          {form.audience === "REOPENED" && (
            <Field label="Necha soatdan keyin “qayta ochildi” hisoblanadi" hint={`${D.reopenMinHours}…${D.reopenMaxHours} soat`}>
              <input
                type="number"
                min={D.reopenMinHours}
                max={D.reopenMaxHours}
                className={`${inputClass} w-32`}
                value={form.reopenAfterHours}
                onChange={(e) => set({ reopenAfterHours: Math.round(Number(e.target.value) || 0) })}
              />
            </Field>
          )}
        </Section>

        <Section index={3} title="Javob" description="Bir xil matn takrorlanmasligi uchun 3–10 ta variant. Faqat tasdiqlangan variantlar yuboriladi.">
          <Field label="Direct javob variantlari">
            <VariantsEditor
              kind="DM"
              items={form.variants}
              onChange={(variants) => set({ variants })}
              replyMode={form.replyMode}
              defaultGoal={`${form.name}: ${AUTOMATION_KIND_LABELS[form.kind].description.toLowerCase()} Direct'da javob berish`}
              keywordsContext={keywordsContext}
              onApproveSaved={approveSaved}
            />
          </Field>
          {form.variants.length > 1 && (
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
          {noApproved && !form.responseMessage.trim() && (
            <Notice tone="warning">Kamida bitta variant yozing — aks holda javob ketmaydi.</Notice>
          )}
          <Field
            label="Quick reply tugmalari (ixtiyoriy)"
            hint="Javob ostida darhol chiqadi — odam o'zi yozgani uchun oyna ochiq, ochish tugmasi kerak emas."
          >
            <QuickRepliesEditor items={form.quickReplies} onChange={(quickReplies) => set({ quickReplies })} />
          </Field>
        </Section>

        <Section index={4} title="Follow-up" description="Javob bermaganlarga eslatma.">
          <Notice tone="info">
            Meta&apos;ning 24 soat qoidasi: odam oxirgi marta yozgan paytdan 24 soat o&apos;tsa, xabar yuborib bo&apos;lmaydi.
            Shuning uchun kechikish ko&apos;pi bilan 23 soat; oyna yopilgan bo&apos;lsa follow-up sababi bilan o&apos;tkazib
            yuboriladi.
          </Notice>
          <FollowUpsEditor
            items={form.followUps}
            onChange={(followUps) => set({ followUps })}
            conditions={DM_FOLLOW_UP_CONDITIONS}
            delayLabel="Javobdan keyin (daqiqa)"
          />
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
        </Section>

        <Section index={5} title="Kengaytirilgan" description="Ko'pchilik kampaniyaga standart qiymatlar yetadi.">
          <Advanced label={`Prioritet ${form.priority} · takroriy javob ${form.cooldownHours} soatda · zaxira matn`}>
            <Field
              label="Prioritet"
              hint="Bir nechta kampaniya mos kelsa: aniq kalit so'z → kalit so'z bor → intent → har bir xabar; keyin shu raqam (kattasi yutadi)."
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
            <Field
              label="Bir odamga takroriy javob oralig'i (soat)"
              hint={`Spamga qarshi: shu kampaniya bir odamga ${form.cooldownHours} soatda ko'pi bilan bir marta javob beradi (${D.cooldownMinHours}…${D.cooldownMaxHours}).`}
            >
              <input
                type="number"
                min={D.cooldownMinHours}
                max={D.cooldownMaxHours}
                className={`${inputClass} w-32`}
                value={form.cooldownHours}
                onChange={(e) => set({ cooldownHours: Math.round(Number(e.target.value) || 0) })}
              />
            </Field>
            <Field
              label="Zaxira javob matni"
              hint={
                form.responseMessage.trim()
                  ? "Tasdiqlangan variant bo'lmasa shu yuboriladi."
                  : "Bo'sh qolsa, 1-tasdiqlangan variant zaxira sifatida saqlanadi."
              }
            >
              <textarea
                className={`${inputClass} min-h-20`}
                value={form.responseMessage}
                maxLength={L.messageLength}
                onChange={(e) => set({ responseMessage: e.target.value })}
              />
              <CharCount value={form.responseMessage} max={L.messageLength} />
            </Field>
          </Advanced>
        </Section>

        <Section index={6} title="Test" description="Xabar yozib ko'ring: qaysi kampaniya, nima uchun va qanday javob. Hech narsa yuborilmaydi.">
          <DmSimulator
            key={form.kind}
            accountId={form.accountId}
            campaignId={campaignId}
            kind={form.kind}
            sampleAdId={form.adIds[0]}
            sampleRef={form.refs[0]}
            dirty={dirty}
            active={savedForm?.active ?? true}
          />
        </Section>

        <div className="sticky bottom-0 z-10 -mx-1 space-y-2 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={primaryButton} onClick={() => void save()} disabled={saving}>
              {saving ? "Saqlanmoqda…" : campaignId ? "Saqlash" : "Kampaniya yaratish"}
            </button>
            <Link href="/developer/triggers" className={secondaryButton}>
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
