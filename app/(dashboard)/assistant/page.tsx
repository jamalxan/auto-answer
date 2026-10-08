"use client";

/**
 * Assistant — set up the lead-collecting assistant in three steps:
 * (1) auto-fill a draft (Instagram + website, or the Telegram Q&A),
 * (2) review and edit the profile and rules, (3) try it in the test chat.
 * An unapproved profile never goes live.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Field,
  Notice,
  Section,
  ToggleRow,
  inputClass,
} from "@/components/assistant-ui";
import { useLanguage } from "@/components/language-provider";
import { parsePrice } from "@/lib/assistant/price";
import { formatShortMonthDayTime } from "@/lib/i18n/format-date";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ProductForm {
  key: string;
  name: string;
  priceText: string;
  priceIsFrom: boolean;
  currency: string;
}

interface FormState {
  companyName: string;
  description: string;
  categories: Array<{ name: string; note: string }>;
  products: ProductForm[];
  pricePolicy: "NEVER" | "FROM_ONLY" | "EXACT";
  tone: "FRIENDLY" | "FORMAL";
  personaName: string;
  extraFieldLabel: string;
  finalMessageTemplate: string;
  address: string;
  delivery: string;
  workingHoursText: string;
  hoursEnabled: boolean;
  hoursDays: number[];
  hoursFrom: string;
  hoursTo: string;
  offHoursMessage: string;
  paymentMethods: string;
  faqs: Array<{ question: string; answer: string }>;
  handleCampaignReplies: boolean;
  handleInboundDm: boolean;
  operatorPauseHours: number;
  maxBotMessages: number;
  fallbackLeadWithoutPhone: boolean;
  postHandoffReply: boolean;
  priceReminderEnabled: boolean;
}

interface ServerProfile {
  id: string;
  enabled: boolean;
  approvedAt: string | null;
  companyName: string;
  description: string;
  pricePolicy: FormState["pricePolicy"];
  tone: FormState["tone"];
  personaName: string | null;
  extraFieldLabel: string | null;
  finalMessageTemplate: string | null;
  handleCampaignReplies: boolean;
  handleInboundDm: boolean;
  operatorPauseHours: number;
  maxBotMessages: number;
  fallbackLeadWithoutPhone: boolean;
  postHandoffReply: boolean;
  workingHours: { text?: string; enabled?: boolean; days?: number[]; from?: string; to?: string } | null;
  offHoursMessage: string | null;
  address: string | null;
  delivery: string | null;
  paymentMethods: string[];
  categories: Array<{ name: string; note?: string }>;
  priceReminderEnabled: boolean;
  source: "PANEL" | "TELEGRAM";
  updatedAt: string;
  products: Array<{ id: string; name: string; note: string | null; price: number | null; priceIsFrom: boolean; currency: string }>;
  faqs: Array<{ id: string; question: string; answer: string; source: string }>;
  charCount: number;
  charLimit: number;
  instructionWarnings: string[];
  learningEnabled: boolean;
  learnedStyle: string | null;
  learnedExamples: Array<{ customer: string; reply: string }>;
  learnedAt: string | null;
  learnedDialogues: number;
}

interface Gap {
  id: string;
  question: string;
  hits: number;
}

interface SandboxMessage {
  role: "user" | "assistant";
  text: string;
  blocked?: boolean;
}

interface SandboxState {
  state: "NEW" | "NEED" | "CONTACT" | "HANDED_OFF";
  collected: Record<string, unknown>;
  botMessageCount: number;
  phoneAskCount: number;
  spamStreak: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

let keySeed = 0;
const nextKey = () => `p${++keySeed}`;

function priceToText(price: number | null): string {
  return price === null ? "" : String(Math.round(price)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function toForm(profile: ServerProfile | null): FormState {
  const hours = profile?.workingHours ?? null;
  return {
    companyName: profile?.companyName ?? "",
    description: profile?.description ?? "",
    categories: (profile?.categories ?? []).map((c) => ({ name: c.name, note: c.note ?? "" })),
    products: (profile?.products ?? []).map((p) => ({
      key: nextKey(),
      name: p.name,
      priceText: priceToText(p.price),
      priceIsFrom: p.priceIsFrom,
      currency: p.currency,
    })),
    pricePolicy: profile?.pricePolicy ?? "NEVER",
    tone: profile?.tone ?? "FRIENDLY",
    personaName: profile?.personaName ?? "",
    extraFieldLabel: profile?.extraFieldLabel ?? "",
    finalMessageTemplate: profile?.finalMessageTemplate ?? "",
    address: profile?.address ?? "",
    delivery: profile?.delivery ?? "",
    workingHoursText: hours?.text ?? "",
    hoursEnabled: hours?.enabled ?? false,
    hoursDays: hours?.days ?? [1, 2, 3, 4, 5, 6],
    hoursFrom: hours?.from ?? "09:00",
    hoursTo: hours?.to ?? "18:00",
    offHoursMessage: profile?.offHoursMessage ?? "",
    paymentMethods: (profile?.paymentMethods ?? []).join(", "),
    faqs: (profile?.faqs ?? []).filter((f) => f.source === "OWNER").map((f) => ({ question: f.question, answer: f.answer })),
    handleCampaignReplies: profile?.handleCampaignReplies ?? true,
    handleInboundDm: profile?.handleInboundDm ?? false,
    operatorPauseHours: profile?.operatorPauseHours ?? 24,
    maxBotMessages: profile?.maxBotMessages ?? 6,
    fallbackLeadWithoutPhone: profile?.fallbackLeadWithoutPhone ?? true,
    postHandoffReply: profile?.postHandoffReply ?? false,
    priceReminderEnabled: profile?.priceReminderEnabled ?? true,
  };
}

function formCharCount(f: FormState): number {
  return (
    f.companyName.length +
    f.description.length +
    f.categories.reduce((n, c) => n + c.name.length + c.note.length, 0) +
    f.faqs.reduce((n, q) => n + q.question.length + q.answer.length, 0) +
    f.address.length +
    f.delivery.length +
    f.workingHoursText.length
  );
}

async function api<T = unknown>(method: string, url: string, body?: unknown) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json();
    return payload.success
      ? { ok: true as const, data: payload.data as T }
      : { ok: false as const, error: payload.error as string | undefined, code: payload.code as string | undefined };
  } catch {
    return { ok: false as const, error: "network", code: undefined };
  }
}

type Step = "autofill" | "edit" | "test" | "learn";

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function AssistantPage() {
  const { t, locale } = useLanguage();
  const A = t.assistant.assistant;
  const C = t.assistant.common;

  const [accounts, setAccounts] = useState<Array<{ id: string; username: string }>>([]);
  const [scope, setScope] = useState<string>("all");
  const [profile, setProfile] = useState<ServerProfile | null>(null);
  const [form, setForm] = useState<FormState>(() => toForm(null));
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [step, setStep] = useState<Step>("autofill");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);

  const instagramAccountId = scope === "all" ? null : scope;

  const load = useCallback(
    async (keepStep = true) => {
      const query = instagramAccountId ? `?instagramAccountId=${instagramAccountId}` : "";
      const result = await api<{
        profile: ServerProfile | null;
        accounts: Array<{ id: string; username: string }>;
        canManage: boolean;
      }>("GET", `/api/assistant/profile${query}`);
      if (!result.ok) {
        setLoadError(true);
        setLoading(false);
        return;
      }
      setLoadError(false);
      setAccounts(result.data.accounts);
      setCanManage(result.data.canManage);
      setProfile(result.data.profile);
      setForm(toForm(result.data.profile));
      setDirty(false);
      if (!keepStep) setStep(result.data.profile?.companyName ? "edit" : "autofill");
      setLoading(false);
    },
    [instagramAccountId]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function patch(update: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...update }));
    setDirty(true);
  }

  const charCount = useMemo(() => formCharCount(form), [form]);
  const overLimit = charCount > (profile?.charLimit ?? 6000);

  function buildPayload() {
    return {
      instagramAccountId,
      companyName: form.companyName.trim(),
      description: form.description.trim(),
      categories: form.categories.filter((c) => c.name.trim()).map((c) => ({ name: c.name.trim(), note: c.note.trim() || undefined })),
      products: form.products
        .filter((p) => p.name.trim())
        .map((p) => {
          const parsed = p.priceText.trim() ? parsePrice(p.priceText) : null;
          return {
            name: p.name.trim(),
            price: parsed?.amount ?? null,
            priceIsFrom: p.priceIsFrom || (parsed?.isFrom ?? false),
            currency: (parsed?.currency ?? p.currency ?? "UZS") as "UZS" | "USD" | "RUB",
          };
        }),
      pricePolicy: form.pricePolicy,
      tone: form.tone,
      personaName: form.personaName.trim() || null,
      extraFieldLabel: form.extraFieldLabel.trim() || null,
      finalMessageTemplate: form.finalMessageTemplate.trim() || null,
      address: form.address.trim() || null,
      delivery: form.delivery.trim() || null,
      workingHours: {
        text: form.workingHoursText.trim() || undefined,
        enabled: form.hoursEnabled,
        days: form.hoursDays,
        from: form.hoursFrom,
        to: form.hoursTo,
      },
      offHoursMessage: form.offHoursMessage.trim() || null,
      paymentMethods: form.paymentMethods.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10),
      faqs: form.faqs.filter((f) => f.question.trim() && f.answer.trim()).slice(0, 5),
      handleCampaignReplies: form.handleCampaignReplies,
      handleInboundDm: form.handleInboundDm,
      operatorPauseHours: form.operatorPauseHours,
      maxBotMessages: form.maxBotMessages,
      fallbackLeadWithoutPhone: form.fallbackLeadWithoutPhone,
      postHandoffReply: form.postHandoffReply,
      priceReminderEnabled: form.priceReminderEnabled,
    };
  }

  async function save(): Promise<boolean> {
    setBusy("save");
    setNotice(null);
    const result = await api<{ profile: ServerProfile }>("PUT", "/api/assistant/profile", buildPayload());
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.code === "profile_too_long" ? A.profile.tooLong : A.errors.save });
      return false;
    }
    setProfile(result.data.profile);
    setDirty(false);
    setNotice({ tone: "success", text: C.saved });
    return true;
  }

  async function approve() {
    if (!(await save())) return;
    setBusy("approve");
    const result = await api("POST", "/api/assistant/profile/approve", { instagramAccountId, enable: true });
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.code === "profile_incomplete" ? A.errors.incomplete : A.errors.approve });
      return;
    }
    await load();
    setNotice({ tone: "success", text: A.statusOn });
  }

  async function setEnabled(enabled: boolean) {
    setBusy("toggle");
    setNotice(null);
    const result = await api("PATCH", "/api/assistant/profile/approve", { instagramAccountId, enabled });
    setBusy(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: result.code === "not_approved" ? A.errors.notApproved : A.errors.save });
      return;
    }
    await load();
  }

  if (loading) return <div className="panel h-64 rounded" />;
  if (loadError) return <Notice tone="error">{C.loadError}</Notice>;

  const status = !profile?.approvedAt ? "draft" : profile.enabled ? "on" : "off";
  const disabled = !canManage;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">{A.title}</h1>
        <p className="mt-1 text-sm text-muted">{A.subtitle}</p>
      </div>

      {!canManage && <Notice tone="warning">{C.readOnly}</Notice>}

      <section className="panel flex flex-col gap-3 rounded p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status === "on" ? "success" : status === "draft" ? "warning" : "muted"}>
              {status === "on" ? A.statusOn : status === "draft" ? A.statusDraft : A.statusOff}
            </Badge>
            {profile?.approvedAt && (
              <span className="text-xs text-muted">{A.approvedOn(formatShortMonthDayTime(new Date(profile.approvedAt), locale))}</span>
            )}
          </div>
          {status === "draft" && <p className="text-xs text-muted">{A.statusDraftHelp}</p>}
          {profile?.source === "TELEGRAM" && profile.approvedAt && (
            <p className="text-xs text-muted">{A.fromTelegram(formatShortMonthDayTime(new Date(profile.updatedAt), locale))}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {accounts.length > 1 && (
            <select
              value={scope}
              onChange={(e) => {
                setLoading(true);
                setScope(e.target.value);
              }}
              className={`${inputClass} w-auto`}
              aria-label={A.accountScope}
            >
              <option value="all">{A.allAccounts}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
          )}
          {status === "on" && (
            <Button tone="ghost" disabled={disabled || busy !== null} onClick={() => void setEnabled(false)}>
              {A.disable}
            </Button>
          )}
          {status === "off" && (
            <Button disabled={disabled || busy !== null} onClick={() => void setEnabled(true)}>
              {A.enable}
            </Button>
          )}
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto" role="tablist">
        {(["autofill", "edit", "test", "learn"] as Step[]).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={step === s}
            onClick={() => setStep(s)}
            className={`whitespace-nowrap rounded-lg border px-4 py-2 text-sm font-medium ${
              step === s ? "border-accent/30 bg-accent/15 text-accent" : "border-border text-muted hover:text-foreground"
            }`}
          >
            {A.steps[s]}
          </button>
        ))}
      </div>

      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      {step === "autofill" && (
        <AutofillStep
          accountId={instagramAccountId}
          disabled={disabled}
          onDraft={(draft) => {
            setForm((prev) => ({
              ...prev,
              companyName: draft.companyName || prev.companyName,
              description: draft.description || prev.description,
              categories: draft.categories.length ? draft.categories.map((c) => ({ name: c.name, note: c.note ?? "" })) : prev.categories,
              address: draft.address ?? prev.address,
              delivery: draft.delivery ?? prev.delivery,
              workingHoursText: draft.workingHours ?? prev.workingHoursText,
            }));
            setDirty(true);
            setNotice({ tone: "success", text: A.autofill.done });
            setStep("edit");
          }}
          onSkip={() => setStep("edit")}
        />
      )}

      {step === "edit" && (
        <>
          <ProfileEditor form={form} patch={patch} disabled={disabled} charCount={charCount} overLimit={overLimit} warnings={profile?.instructionWarnings ?? []} charLimit={profile?.charLimit ?? 6000} />
          <RulesEditor form={form} patch={patch} disabled={disabled} />
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={disabled || busy !== null || overLimit} onClick={() => void save()}>
              {busy === "save" ? C.saving : C.save}
            </Button>
            <Button tone="ghost" disabled={disabled || busy !== null || overLimit || !form.companyName.trim()} onClick={() => void approve()}>
              {busy === "approve" ? A.approving : A.approve}
            </Button>
            {dirty && <span className="text-xs text-warning">●</span>}
          </div>
        </>
      )}

      {step === "test" && (
        <SandboxStep
          accountId={instagramAccountId}
          hasProfile={Boolean(profile?.companyName)}
          dirty={dirty}
          onSave={save}
        />
      )}

      {step === "learn" && (
        <LearningStep
          key={`${profile?.id ?? "none"}:${profile?.updatedAt ?? ""}`}
          accountId={instagramAccountId}
          profile={profile}
          disabled={disabled}
          onProfile={setProfile}
        />
      )}

      <GapsSection canManage={canManage} />
      <ChangesSection accountId={instagramAccountId} />
    </div>
  );
}

// ─── Step 1 ────────────────────────────────────────────────────────────────────

function AutofillStep({
  accountId,
  disabled,
  onDraft,
  onSkip,
}: {
  accountId: string | null;
  disabled: boolean;
  onDraft: (draft: {
    companyName: string;
    description: string;
    categories: Array<{ name: string; note?: string }>;
    address: string | null;
    delivery: string | null;
    workingHours: string | null;
  }) => void;
  onSkip: () => void;
}) {
  const { t } = useLanguage();
  const F = t.assistant.assistant.autofill;
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const result = await api<{ draft: Parameters<typeof onDraft>[0] }>("POST", "/api/assistant/profile/autofill", {
      instagramAccountId: accountId,
      websiteUrl: website.trim() || null,
    });
    setBusy(false);
    if (result.ok) onDraft(result.data.draft);
    else setError(F.errors[result.code ?? ""] ?? F.errors.autofill_failed);
  }

  async function openTelegram() {
    setError(null);
    const result = await api<{ url: string }>("POST", "/api/assistant/telegram-onboarding/link", { instagramAccountId: accountId });
    if (result.ok) window.open(result.data.url, "_blank", "noopener");
    else setError(F.telegramError);
  }

  return (
    <div className="space-y-4">
      <Section title={F.title} description={F.help}>
        <Field label={F.websiteLabel}>
          <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={F.websitePlaceholder} className={inputClass} disabled={disabled} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled || busy} onClick={() => void run()}>
            {busy ? F.running : F.run}
          </Button>
          <Button tone="ghost" onClick={onSkip}>
            {F.skipToEdit}
          </Button>
        </div>
      </Section>
      <Section title={F.telegramTitle} description={F.telegramHelp}>
        <Button tone="ghost" disabled={disabled} onClick={() => void openTelegram()}>
          {F.telegramBtn}
        </Button>
      </Section>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}

// ─── Step 2 ────────────────────────────────────────────────────────────────────

function ProfileEditor({
  form,
  patch,
  disabled,
  charCount,
  overLimit,
  charLimit,
  warnings,
}: {
  form: FormState;
  patch: (update: Partial<FormState>) => void;
  disabled: boolean;
  charCount: number;
  overLimit: boolean;
  charLimit: number;
  warnings: string[];
}) {
  const { t } = useLanguage();
  const P = t.assistant.assistant.profile;
  const C = t.assistant.common;
  const [bulk, setBulk] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  async function applyBulk() {
    if (!bulk.trim()) return;
    setBulkBusy(true);
    const result = await api<{
      products: Array<{ name: string; price: number | null; priceIsFrom: boolean; currency: string }>;
    }>("POST", "/api/assistant/products/parse", { text: bulk });
    setBulkBusy(false);
    if (!result.ok) return;
    patch({
      products: [
        ...form.products,
        ...result.data.products.map((p) => ({
          key: nextKey(),
          name: p.name,
          priceText: priceToText(p.price),
          priceIsFrom: p.priceIsFrom,
          currency: p.currency,
        })),
      ].slice(0, 200),
    });
    setBulk("");
  }

  return (
    <div className="space-y-4">
      <Section title={P.company}>
        <Field label={P.company}>
          <input value={form.companyName} maxLength={100} onChange={(e) => patch({ companyName: e.target.value })} className={inputClass} disabled={disabled} />
        </Field>
        <Field label={P.description} help={P.descriptionHelp}>
          <textarea value={form.description} maxLength={1000} rows={3} onChange={(e) => patch({ description: e.target.value })} className={inputClass} disabled={disabled} />
        </Field>
        <p className={`text-xs ${overLimit ? "text-error" : "text-muted"}`}>
          {P.counter(charCount, charLimit)}
          {overLimit ? ` — ${P.tooLong}` : ""}
        </p>
        {warnings.length > 0 && <Notice tone="warning">{P.instructionWarning}</Notice>}
      </Section>

      <Section title={P.categories} description={P.categoriesHelp}>
        <div className="space-y-2">
          {form.categories.map((c, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <input
                value={c.name}
                placeholder={P.categoryName}
                maxLength={80}
                onChange={(e) => patch({ categories: form.categories.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                className={inputClass}
                disabled={disabled}
              />
              <input
                value={c.note}
                placeholder={P.categoryNote}
                maxLength={160}
                onChange={(e) => patch({ categories: form.categories.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)) })}
                className={inputClass}
                disabled={disabled}
              />
              <Button tone="ghost" disabled={disabled} onClick={() => patch({ categories: form.categories.filter((_, j) => j !== i) })}>
                ×
              </Button>
            </div>
          ))}
        </div>
        <Button tone="ghost" disabled={disabled || form.categories.length >= 30} onClick={() => patch({ categories: [...form.categories, { name: "", note: "" }] })}>
          + {C.add}
        </Button>
      </Section>

      <Section title={P.products} description={P.productsHelp}>
        <div className="space-y-2">
          {form.products.map((p, i) => (
            <div key={p.key} className="grid grid-cols-[1fr_8rem_auto_auto] items-center gap-2">
              <input
                value={p.name}
                placeholder={P.productName}
                maxLength={120}
                onChange={(e) => patch({ products: form.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                className={inputClass}
                disabled={disabled}
              />
              <input
                value={p.priceText}
                placeholder={P.productPrice}
                inputMode="decimal"
                onChange={(e) => patch({ products: form.products.map((x, j) => (j === i ? { ...x, priceText: e.target.value } : x)) })}
                onBlur={() => {
                  const parsed = p.priceText.trim() ? parsePrice(p.priceText) : null;
                  if (parsed?.amount != null) {
                    patch({ products: form.products.map((x, j) => (j === i ? { ...x, priceText: priceToText(parsed.amount), priceIsFrom: x.priceIsFrom || parsed.isFrom, currency: parsed.currency } : x)) });
                  }
                }}
                className={inputClass}
                disabled={disabled}
              />
              <label className="flex items-center gap-1 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={p.priceIsFrom}
                  onChange={(e) => patch({ products: form.products.map((x, j) => (j === i ? { ...x, priceIsFrom: e.target.checked } : x)) })}
                  disabled={disabled}
                />
                {P.productFrom}
              </label>
              <Button tone="ghost" disabled={disabled} onClick={() => patch({ products: form.products.filter((_, j) => j !== i) })}>
                ×
              </Button>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            tone="ghost"
            disabled={disabled || form.products.length >= 200}
            onClick={() => patch({ products: [...form.products, { key: nextKey(), name: "", priceText: "", priceIsFrom: false, currency: "UZS" }] })}
          >
            + {C.add}
          </Button>
          <span className="text-xs text-muted">{form.products.length}/200</span>
        </div>
        <Field label={P.bulkTitle}>
          <textarea value={bulk} rows={4} onChange={(e) => setBulk(e.target.value)} placeholder={P.bulkPlaceholder} className={`${inputClass} font-mono text-xs`} disabled={disabled} />
        </Field>
        <Button tone="ghost" disabled={disabled || bulkBusy || !bulk.trim()} onClick={() => void applyBulk()}>
          {P.bulkApply}
        </Button>
      </Section>

      <Section title={P.pricePolicy} description={P.policyHelp}>
        <div className="space-y-2">
          {(
            [
              ["NEVER", P.policyNever],
              ["FROM_ONLY", P.policyFrom],
              ["EXACT", P.policyExact],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm text-foreground">
              <input type="radio" name="pricePolicy" checked={form.pricePolicy === value} onChange={() => patch({ pricePolicy: value })} disabled={disabled} />
              {label}
            </label>
          ))}
        </div>
      </Section>

      <Section title={P.tone}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={P.tone}>
            <select value={form.tone} onChange={(e) => patch({ tone: e.target.value as FormState["tone"] })} className={inputClass} disabled={disabled}>
              <option value="FRIENDLY">{P.toneFriendly}</option>
              <option value="FORMAL">{P.toneFormal}</option>
            </select>
          </Field>
          <Field label={P.persona} help={P.personaHelp}>
            <input value={form.personaName} maxLength={40} onChange={(e) => patch({ personaName: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
          <Field label={P.extraField} help={P.extraFieldHelp}>
            <input value={form.extraFieldLabel} maxLength={60} onChange={(e) => patch({ extraFieldLabel: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
          <Field label={P.finalMessage} help={P.finalMessageHelp}>
            <input value={form.finalMessageTemplate} maxLength={300} placeholder="Rahmat, {name}! Menejerimiz tez orada {phone} raqamiga bog'lanadi." onChange={(e) => patch({ finalMessageTemplate: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
        </div>
      </Section>

      <Section title={`${P.address} · ${P.delivery}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={P.address}>
            <input value={form.address} maxLength={300} onChange={(e) => patch({ address: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
          <Field label={P.delivery}>
            <input value={form.delivery} maxLength={200} onChange={(e) => patch({ delivery: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
          <Field label={P.workingHours}>
            <input value={form.workingHoursText} maxLength={200} placeholder="Du–Sha 9:00–18:00" onChange={(e) => patch({ workingHoursText: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
          <Field label={P.payments}>
            <input value={form.paymentMethods} placeholder="Naqd, Click, Payme" onChange={(e) => patch({ paymentMethods: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
        </div>
      </Section>

      <Section title={P.faqs} description={P.faqsHelp}>
        <div className="space-y-2">
          {form.faqs.map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <input value={f.question} placeholder={P.faqQuestion} maxLength={200} onChange={(e) => patch({ faqs: form.faqs.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) })} className={inputClass} disabled={disabled} />
              <input value={f.answer} placeholder={P.faqAnswer} maxLength={400} onChange={(e) => patch({ faqs: form.faqs.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) })} className={inputClass} disabled={disabled} />
              <Button tone="ghost" disabled={disabled} onClick={() => patch({ faqs: form.faqs.filter((_, j) => j !== i) })}>
                ×
              </Button>
            </div>
          ))}
        </div>
        <Button tone="ghost" disabled={disabled || form.faqs.length >= 5} onClick={() => patch({ faqs: [...form.faqs, { question: "", answer: "" }] })}>
          + {C.add}
        </Button>
      </Section>
    </div>
  );
}

function RulesEditor({
  form,
  patch,
  disabled,
}: {
  form: FormState;
  patch: (update: Partial<FormState>) => void;
  disabled: boolean;
}) {
  const { t } = useLanguage();
  const R = t.assistant.assistant.rules;
  return (
    <Section title={R.title}>
      <div className="space-y-2">
        <ToggleRow label={R.campaignReplies} on={form.handleCampaignReplies} onToggle={() => patch({ handleCampaignReplies: !form.handleCampaignReplies })} disabled={disabled} />
        <ToggleRow label={R.inboundDm} on={form.handleInboundDm} onToggle={() => patch({ handleInboundDm: !form.handleInboundDm })} disabled={disabled} />
        <ToggleRow label={R.fallbackLead} on={form.fallbackLeadWithoutPhone} onToggle={() => patch({ fallbackLeadWithoutPhone: !form.fallbackLeadWithoutPhone })} disabled={disabled} />
        <ToggleRow label={R.postHandoff} on={form.postHandoffReply} onToggle={() => patch({ postHandoffReply: !form.postHandoffReply })} disabled={disabled} />
        <ToggleRow label={R.priceReminder} on={form.priceReminderEnabled} onToggle={() => patch({ priceReminderEnabled: !form.priceReminderEnabled })} disabled={disabled} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={R.operatorPause} help={R.operatorPauseHelp}>
          <input type="number" min={1} max={72} value={form.operatorPauseHours} onChange={(e) => patch({ operatorPauseHours: Math.min(72, Math.max(1, Number(e.target.value) || 24)) })} className={inputClass} disabled={disabled} />
        </Field>
        <Field label={R.maxMessages}>
          <input type="number" min={2} max={12} value={form.maxBotMessages} onChange={(e) => patch({ maxBotMessages: Math.min(12, Math.max(2, Number(e.target.value) || 6)) })} className={inputClass} disabled={disabled} />
        </Field>
      </div>
      <ToggleRow label={R.hoursFilter} help={R.hoursFilterHelp} on={form.hoursEnabled} onToggle={() => patch({ hoursEnabled: !form.hoursEnabled })} disabled={disabled} />
      {form.hoursEnabled && (
        <div className="space-y-3 rounded border border-border p-3">
          <div className="flex flex-wrap gap-2">
            {R.days.map((day, index) => {
              const on = form.hoursDays.includes(index);
              return (
                <button
                  key={day}
                  type="button"
                  disabled={disabled}
                  onClick={() => patch({ hoursDays: on ? form.hoursDays.filter((d) => d !== index) : [...form.hoursDays, index].sort() })}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${on ? "border-accent/40 bg-accent/15 text-accent" : "border-border text-muted"}`}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={R.from}>
              <input type="time" value={form.hoursFrom} onChange={(e) => patch({ hoursFrom: e.target.value })} className={inputClass} disabled={disabled} />
            </Field>
            <Field label={R.to}>
              <input type="time" value={form.hoursTo} onChange={(e) => patch({ hoursTo: e.target.value })} className={inputClass} disabled={disabled} />
            </Field>
          </div>
          <Field label={R.offHoursMessage}>
            <textarea value={form.offHoursMessage} rows={2} maxLength={300} onChange={(e) => patch({ offHoursMessage: e.target.value })} className={inputClass} disabled={disabled} />
          </Field>
        </div>
      )}
    </Section>
  );
}

// ─── Step 3 ────────────────────────────────────────────────────────────────────

function SandboxStep({
  accountId,
  hasProfile,
  dirty,
  onSave,
}: {
  accountId: string | null;
  hasProfile: boolean;
  dirty: boolean;
  onSave: () => Promise<boolean>;
}) {
  const { t } = useLanguage();
  const S = t.assistant.assistant.sandbox;
  const [messages, setMessages] = useState<SandboxMessage[]>([]);
  const [state, setState] = useState<SandboxState | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setError(null);
    if (dirty && !(await onSave())) return;
    setBusy(true);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setDraft("");
    const result = await api<{
      reply: string | null;
      state: SandboxState;
      lead: { summary: string | null } | null;
      blocked: boolean;
    }>("POST", "/api/assistant/sandbox", { instagramAccountId: accountId, message: text, state: state ?? undefined });
    setBusy(false);
    if (!result.ok) {
      setError(result.code === "no_llm" ? S.noLlm : result.code === "no_profile" ? S.saveFirst : t.assistant.common.loadError);
      return;
    }
    setState(result.data.state);
    if (result.data.reply) {
      setMessages((prev) => [...prev, { role: "assistant", text: result.data.reply!, blocked: result.data.blocked }]);
    }
    if (result.data.lead) setLead(result.data.lead.summary ?? "");
  }

  function reset() {
    setMessages([]);
    setState(null);
    setLead(null);
    setError(null);
  }

  return (
    <Section title={S.title} description={S.help} action={<Button tone="ghost" onClick={reset}>{S.reset}</Button>}>
      {!hasProfile && <Notice tone="warning">{S.saveFirst}</Notice>}
      <div className="mx-auto w-full max-w-sm rounded-[2rem] border-4 border-border bg-background p-2">
        <div className="flex h-[26rem] flex-col overflow-hidden rounded-[1.5rem] bg-surface">
          <div className="border-b border-border px-4 py-2.5 text-center text-xs font-semibold text-foreground">Instagram · {S.title}</div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {messages.length === 0 && <p className="pt-8 text-center text-xs text-muted">{S.empty}</p>}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                    m.role === "user" ? "bg-accent text-background" : "border border-border bg-surface-hover text-foreground"
                  }`}
                >
                  {m.text}
                  {m.blocked && <span className="mt-1 block text-[10px] text-warning">{S.blocked}</span>}
                </div>
              </div>
            ))}
            {busy && <p className="text-xs italic text-muted">{S.thinking}</p>}
            <div ref={endRef} />
          </div>
          <div className="flex gap-2 border-t border-border p-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void send();
              }}
              placeholder={S.placeholder}
              maxLength={1000}
              className={`${inputClass} rounded-full`}
            />
            <Button disabled={busy || !draft.trim()} onClick={() => void send()}>
              {S.send}
            </Button>
          </div>
        </div>
      </div>
      {lead !== null && <Notice tone="success">{S.leadCreated(lead)}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}

// ─── Step 4: learn from managers ───────────────────────────────────────────────

function LearningStep({
  accountId,
  profile,
  disabled,
  onProfile,
}: {
  accountId: string | null;
  profile: ServerProfile | null;
  disabled: boolean;
  onProfile: (profile: ServerProfile) => void;
}) {
  const { t, locale } = useLanguage();
  const L = t.assistant.assistant.learning;
  const C = t.assistant.common;
  const [style, setStyle] = useState(profile?.learnedStyle ?? "");
  const [examples, setExamples] = useState(profile?.learnedExamples ?? []);
  const [busy, setBusy] = useState<"toggle" | "learn" | "save" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "warning"; text: string } | null>(null);
  const dirty =
    style !== (profile?.learnedStyle ?? "") ||
    JSON.stringify(examples) !== JSON.stringify(profile?.learnedExamples ?? []);
  const locked = disabled || !profile?.companyName;

  async function put(body: Record<string, unknown>): Promise<boolean> {
    const result = await api<{ profile: ServerProfile }>("PUT", "/api/assistant/profile", {
      instagramAccountId: accountId,
      ...body,
    });
    if (!result.ok) {
      setNotice({ tone: "error", text: t.assistant.assistant.errors.save });
      return false;
    }
    onProfile(result.data.profile);
    return true;
  }

  async function toggle() {
    setBusy("toggle");
    setNotice(null);
    await put({ learningEnabled: !profile?.learningEnabled });
    setBusy(null);
  }

  async function learnNow() {
    setBusy("learn");
    setNotice(null);
    const result = await api<
      | { status: "learned"; dialogues: number; rules: number; examples: number }
      | { status: "not_enough"; dialogues: number }
    >("POST", "/api/assistant/learning", { instagramAccountId: accountId });
    if (!result.ok) {
      setBusy(null);
      setNotice({ tone: "error", text: result.code === "no_llm" ? L.noLlm : L.failed });
      return;
    }
    if (result.data.status === "not_enough") {
      setBusy(null);
      setNotice({ tone: "warning", text: L.notEnough(result.data.dialogues) });
      return;
    }
    const { dialogues, rules, examples: count } = result.data;
    // Reload so the learned style and its timestamp show up.
    const fresh = await api<{ profile: ServerProfile | null }>(
      "GET",
      `/api/assistant/profile${accountId ? `?instagramAccountId=${accountId}` : ""}`
    );
    setBusy(null);
    if (fresh.ok && fresh.data.profile) onProfile(fresh.data.profile);
    setNotice({ tone: "success", text: L.learned(dialogues, rules, count) });
  }

  async function saveLearned() {
    setBusy("save");
    setNotice(null);
    const ok = await put({ learnedStyle: style.trim() || null, learnedExamples: examples });
    setBusy(null);
    if (ok) setNotice({ tone: "success", text: C.saved });
  }

  return (
    <Section title={L.title} description={L.help}>
      <ToggleRow
        label={L.toggle}
        help={L.toggleHelp}
        on={Boolean(profile?.learningEnabled)}
        onToggle={() => void toggle()}
        disabled={locked || busy !== null}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={locked || busy !== null} onClick={() => void learnNow()}>
          {busy === "learn" ? L.learning : L.learnNow}
        </Button>
        <span className="text-xs text-muted">
          {profile?.learnedAt
            ? L.lastLearned(formatShortMonthDayTime(new Date(profile.learnedAt), locale), profile.learnedDialogues)
            : L.never}
        </span>
      </div>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {profile?.learnedStyle && !profile.learningEnabled && <Notice tone="warning">{L.offNotice}</Notice>}

      {(profile?.learnedStyle || examples.length > 0) && (
        <>
          <Field label={L.styleTitle} help={L.styleHelp}>
            <textarea
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              rows={Math.min(12, Math.max(4, style.split("\n").length + 1))}
              maxLength={2500}
              className={`${inputClass} resize-y`}
              disabled={locked}
            />
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{L.examplesTitle}</p>
            <p className="text-xs text-muted">{L.examplesHelp}</p>
            {examples.length === 0 && <p className="text-sm text-muted">{L.noExamples}</p>}
            {examples.map((example, index) => (
              <div key={`${index}:${example.reply.slice(0, 20)}`} className="rounded-lg border border-border p-3 text-sm">
                <p className="text-muted">
                  <span className="font-medium text-foreground">{L.customer}:</span> {example.customer}
                </p>
                <p className="mt-1 text-foreground">
                  <span className="font-medium text-accent">{L.manager}:</span> {example.reply}
                </p>
                <button
                  type="button"
                  onClick={() => setExamples((prev) => prev.filter((_, i) => i !== index))}
                  disabled={locked}
                  className="mt-2 text-xs text-muted hover:text-error"
                >
                  {L.remove}
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={locked || busy !== null || !dirty} onClick={() => void saveLearned()}>
              {busy === "save" ? C.saving : C.save}
            </Button>
            {dirty && <span className="text-xs text-warning">●</span>}
          </div>
        </>
      )}
    </Section>
  );
}

// ─── Knowledge gaps + change log ───────────────────────────────────────────────

function GapsSection({ canManage }: { canManage: boolean }) {
  const { t } = useLanguage();
  const G = t.assistant.assistant.gaps;
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const result = await api<{ gaps: Gap[] }>("GET", "/api/assistant/knowledge-gaps?status=open");
    if (result.ok) setGaps(result.data.gaps);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function answer(id: string) {
    const text = answers[id]?.trim();
    if (!text) return;
    await api("POST", `/api/assistant/knowledge-gaps/${id}/answer`, { answer: text });
    await load();
  }

  async function ignore(id: string) {
    await api("POST", `/api/assistant/knowledge-gaps/${id}/ignore`);
    await load();
  }

  return (
    <Section title={G.title} description={G.help}>
      {gaps === null ? null : gaps.length === 0 ? (
        <p className="text-sm text-muted">{G.empty}</p>
      ) : (
        <ul className="space-y-3">
          {gaps.map((gap) => (
            <li key={gap.id} className="space-y-2 rounded border border-border p-3">
              <p className="text-sm text-foreground">
                {gap.question} <span className="text-xs text-muted">({G.hits(gap.hits)})</span>
              </p>
              <div className="flex gap-2">
                <input
                  value={answers[gap.id] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [gap.id]: e.target.value }))}
                  placeholder={G.answerPlaceholder}
                  maxLength={400}
                  className={inputClass}
                  disabled={!canManage}
                />
                <Button disabled={!canManage || !answers[gap.id]?.trim()} onClick={() => void answer(gap.id)}>
                  {G.answer}
                </Button>
                <Button tone="ghost" disabled={!canManage} onClick={() => void ignore(gap.id)}>
                  {G.ignore}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ChangesSection({ accountId }: { accountId: string | null }) {
  const { t, locale } = useLanguage();
  const H = t.assistant.assistant.changes;
  const [changes, setChanges] = useState<Array<{ id: string; field: string; source: "PANEL" | "TELEGRAM"; createdAt: string }> | null>(null);

  useEffect(() => {
    const query = accountId ? `?instagramAccountId=${accountId}` : "";
    const timer = window.setTimeout(() => {
      void api<{ changes: NonNullable<typeof changes> }>("GET", `/api/assistant/profile/changes${query}`).then((r) => {
        if (r.ok) setChanges(r.data.changes);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [accountId]);

  return (
    <details className="panel rounded-xl p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">{H.title}</summary>
      <div className="mt-3">
        {!changes || changes.length === 0 ? (
          <p className="text-sm text-muted">{H.empty}</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted">
            {changes.slice(0, 30).map((c) => (
              <li key={c.id}>
                {formatShortMonthDayTime(new Date(c.createdAt), locale)} · {c.field} · {c.source === "TELEGRAM" ? H.telegram : H.panel}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
