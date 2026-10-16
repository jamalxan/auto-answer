"use client";

/**
 * Giveaway wizard, four sections: 1 account and post, 2 rules (each with what
 * the platform can really verify), 3 period and winners, 4 optional
 * participation confirmation through a Comment 2.0 campaign. Edits only a
 * DRAFT; an unsaved indicator shows when the form differs from the last save.
 */

import { useMemo, useState } from "react";
import { Choice, ChipInput, Field, Pill, Toggle, inputClass, primaryButton, secondaryButton } from "@/components/developer/ui";
import { Advanced, Notice, Section } from "@/components/developer/comments/parts";
import PostPicker, { type PickedPost } from "./post-picker";
import {
  ENGAGEMENT_API,
  ON_UNVERIFIABLE_TEXT,
  VERIFIABILITY_TONE,
  jsonInit,
  requestJson,
  toLocalInput,
  type GiveawayRow,
  type GiveawayRules,
  type Meta,
} from "./shared";

interface FormState {
  name: string;
  accountId: string;
  post: PickedPost | null;
  rules: GiveawayRules;
  start: string;
  end: string;
  winners: number;
  backups: number;
  confirmCampaignId: string;
}

const DAY = 24 * 60 * 60 * 1000;

function initial(meta: Meta, giveaway: GiveawayRow | null): FormState {
  if (giveaway) {
    return {
      name: giveaway.name,
      accountId: giveaway.instagramAccountId,
      post: { mediaId: giveaway.mediaId, meta: giveaway.mediaMeta },
      rules: giveaway.rules,
      start: toLocalInput(giveaway.windowStart),
      end: toLocalInput(giveaway.windowEnd),
      winners: giveaway.winnersCount,
      backups: giveaway.backupCount,
      confirmCampaignId: giveaway.confirmCampaignId ?? "",
    };
  }
  const now = Date.now();
  return {
    name: "",
    // The first account is preselected so the post picker loads at once.
    accountId: meta.accounts[0]?.id ?? "",
    post: null,
    rules: structuredClone(meta.defaults.rules),
    start: toLocalInput(new Date(now)),
    end: toLocalInput(new Date(now + 7 * DAY)),
    winners: 1,
    backups: 2,
    confirmCampaignId: "",
  };
}

function RuleRow({
  meta,
  ruleKey,
  on,
  onToggle,
  title,
  disabled,
  children,
}: {
  meta: Meta;
  ruleKey: string;
  on: boolean;
  onToggle: (on: boolean) => void;
  title: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const v = meta.verifiability[ruleKey];
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {v && <Pill tone={VERIFIABILITY_TONE[v.verifiable]}>{v.badge}</Pill>}
        </div>
        {!disabled && <Toggle on={on} onChange={onToggle} label={title} />}
      </div>
      {v && <p className="text-xs text-muted">{v.note}</p>}
      {on && children}
    </div>
  );
}

export default function GiveawayWizard({
  meta,
  giveaway,
  onSaved,
  onCancel,
}: {
  meta: Meta;
  giveaway: GiveawayRow | null;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [saved, setSaved] = useState<FormState>(() => initial(meta, giveaway));
  const [form, setForm] = useState<FormState>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);
  const patch = (next: Partial<FormState>) => setForm((f) => ({ ...f, ...next }));
  const patchRules = (next: Partial<GiveawayRules>) => setForm((f) => ({ ...f, rules: { ...f.rules, ...next } }));

  const campaigns = meta.campaigns.filter((c) => c.instagramAccountId === form.accountId);
  const readOnly = !meta.me.canManage;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        instagramAccountId: form.accountId,
        mediaId: form.post?.mediaId ?? "",
        mediaMeta: form.post?.meta ?? null,
        rules: form.rules,
        windowStart: new Date(form.start).toISOString(),
        windowEnd: new Date(form.end).toISOString(),
        winnersCount: form.winners,
        backupCount: form.backups,
        confirmCampaignId: form.confirmCampaignId || null,
      };
      if (Number.isNaN(new Date(form.start).getTime()) || Number.isNaN(new Date(form.end).getTime())) {
        setError("Boshlanish va tugash vaqtini kiriting");
        return;
      }
      const res = giveaway
        ? await requestJson<{ giveaway: GiveawayRow }>(`${ENGAGEMENT_API}/giveaways/${giveaway.id}`, jsonInit("PATCH", body))
        : await requestJson<{ giveaway: GiveawayRow }>(`${ENGAGEMENT_API}/giveaways`, jsonInit("POST", body));
      if (res.ok) {
        setSaved(form);
        onSaved(res.data.giveaway.id);
      } else setError(res.error);
    } finally {
      setBusy(false);
    }
  }

  const ready = form.name.trim() && form.accountId && form.post?.mediaId && form.winners >= 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">{giveaway ? "Giveaway'ni tahrirlash" : "Yangi giveaway"}</h2>
        <div className="flex items-center gap-2">
          {dirty && <Pill tone="warning">Saqlanmagan o&apos;zgarishlar</Pill>}
          <button type="button" className={secondaryButton} onClick={onCancel}>
            {giveaway ? "Orqaga" : "Bekor"}
          </button>
        </div>
      </div>

      {readOnly && <Notice tone="info">Giveaway yaratish uchun Menejer yoki undan yuqori rol kerak.</Notice>}

      <Section index={1} title="Akkaunt va post" description="Qur'a shu postga yozilgan izohlar bo'yicha o'tkaziladi.">
        <Field label="Giveaway nomi">
          <input className={inputClass} value={form.name} maxLength={120} onChange={(e) => patch({ name: e.target.value })} placeholder="Masalan: Oktabr sovg'asi" disabled={readOnly} />
        </Field>
        <Field label="Instagram akkaunt" hint={meta.accounts.length === 0 ? "Avval Instagram akkaunt ulang." : undefined}>
          <select
            className={inputClass}
            value={form.accountId}
            disabled={readOnly}
            onChange={(e) => patch({ accountId: e.target.value, post: null, confirmCampaignId: "" })}
          >
            <option value="">Tanlang…</option>
            {meta.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
        </Field>
        <PostPicker accountId={form.accountId} value={form.post} onChange={(post) => patch({ post })} disabled={readOnly} />
      </Section>

      <Section index={2} title="Qoidalar" description="Har bir shart yonida platforma uni haqiqatan tekshira olishi yoki olmasligi yozilgan.">
        <RuleRow meta={meta} ruleKey="comment" title="Postga izoh qoldirish" on={form.rules.comment.required} onToggle={(required) => patchRules({ comment: { ...form.rules.comment, required } })} disabled>
          <></>
        </RuleRow>
        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-muted">Qaysi izoh hisoblanadi?</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ["ANY", "Har qanday izoh"],
                ["CONTAINS", "Kalit so'z bor"],
                ["EXACT", "Aynan shu so'z"],
              ] as const
            ).map(([mode, label]) => (
              <Choice key={mode} checked={form.rules.comment.mode === mode} disabled={readOnly} onSelect={() => patchRules({ comment: { ...form.rules.comment, mode } })} title={label} />
            ))}
          </div>
          {form.rules.comment.mode !== "ANY" && (
            <Field label="Kalit so'z(lar)" hint="Vergul bilan ajrating — bittasi bo'lsa yetarli.">
              <input
                className={inputClass}
                value={form.rules.comment.keyword ?? ""}
                maxLength={200}
                disabled={readOnly}
                onChange={(e) => patchRules({ comment: { ...form.rules.comment, keyword: e.target.value } })}
                placeholder="qatnashaman"
              />
            </Field>
          )}
        </div>

        <RuleRow meta={meta} ruleKey="tagFriends" title="Do'stlarni belgilash" on={form.rules.tagFriends.required} disabled={readOnly} onToggle={(required) => patchRules({ tagFriends: { ...form.rules.tagFriends, required } })}>
          <Field label="Kamida nechta do'st (@username)">
            <input
              type="number"
              min={1}
              max={10}
              className={inputClass}
              value={form.rules.tagFriends.min}
              disabled={readOnly}
              onChange={(e) => patchRules({ tagFriends: { ...form.rules.tagFriends, min: Math.min(10, Math.max(1, Number(e.target.value) || 1)) } })}
            />
          </Field>
        </RuleRow>

        <RuleRow meta={meta} ruleKey="mention" title="Story'da akkauntni belgilash" on={form.rules.mention.required} disabled={readOnly} onToggle={(required) => patchRules({ mention: { required } })} />

        <RuleRow meta={meta} ruleKey="follow" title="Akkauntga obuna bo'lish" on={form.rules.follow.required} disabled={readOnly} onToggle={(required) => patchRules({ follow: { ...form.rules.follow, required } })}>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted">Instagram obunani tasdiqlay olmasa nima qilamiz?</p>
            {(["HOLD", "ALLOW", "EXCLUDE"] as const).map((key) => (
              <Choice
                key={key}
                checked={form.rules.follow.onUnverifiable === key}
                disabled={readOnly}
                onSelect={() => patchRules({ follow: { ...form.rules.follow, onUnverifiable: key } })}
                title={ON_UNVERIFIABLE_TEXT[key].title}
                description={ON_UNVERIFIABLE_TEXT[key].description}
              />
            ))}
          </div>
        </RuleRow>

        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="mb-2 text-xs font-semibold text-muted">Bu shartlarni tekshirib bo&apos;lmaydi</p>
          <ul className="space-y-1.5 text-xs text-muted">
            {["like", "save", "share", "followOther"].map((key) => {
              const v = meta.verifiability[key];
              return v ? (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <span className="text-foreground">{v.label}</span>
                  <Pill tone="error">{v.badge}</Pill>
                  <span>{v.note}</span>
                </li>
              ) : null;
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">Ularni post matniga yozishingiz mumkin, lekin g&apos;oliblarni tanlashda hisobga olinmaydi.</p>
        </div>

        <Advanced label="Kengaytirilgan (chetlatilganlar, minimal izoh uzunligi)">
          <Field label="Qatnasha olmaydigan akkauntlar" hint="Masalan, hamkorlar yoki xodimlar.">
            <ChipInput values={form.rules.excludeUsernames} onChange={(excludeUsernames) => patchRules({ excludeUsernames })} placeholder="username kiriting va Enter" max={200} />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-foreground">O&apos;z akkauntimizni chetlatish</span>
            <Toggle on={form.rules.excludeStaff} onChange={(excludeStaff) => patchRules({ excludeStaff })} label="Xodimlarni chetlatish" />
          </div>
          <Field label="Izoh minimal uzunligi (belgi)">
            <input
              type="number"
              min={0}
              max={500}
              className={inputClass}
              value={form.rules.comment.minLength}
              onChange={(e) => patchRules({ comment: { ...form.rules.comment, minLength: Math.min(500, Math.max(0, Number(e.target.value) || 0)) } })}
            />
          </Field>
        </Advanced>
      </Section>

      <Section index={3} title="Davr va g'oliblar soni" description={`Davr ${meta.limits.maxWindowDays} kundan oshmasin. Davrdan tashqaridagi izohlar hisoblanmaydi.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Boshlanish">
            <input type="datetime-local" className={inputClass} value={form.start} disabled={readOnly} onChange={(e) => patch({ start: e.target.value })} />
          </Field>
          <Field label="Tugash">
            <input type="datetime-local" className={inputClass} value={form.end} disabled={readOnly} onChange={(e) => patch({ end: e.target.value })} />
          </Field>
          <Field label="G'oliblar soni" hint={`1–${meta.limits.maxWinners}`}>
            <input type="number" min={1} max={meta.limits.maxWinners} className={inputClass} value={form.winners} disabled={readOnly} onChange={(e) => patch({ winners: Math.min(meta.limits.maxWinners, Math.max(1, Number(e.target.value) || 1)) })} />
          </Field>
          <Field label="Zaxira g'oliblar" hint="G'olib chetlatilsa yoki javob bermasa, zaxiradan olinadi.">
            <input type="number" min={0} max={meta.limits.maxBackups} className={inputClass} value={form.backups} disabled={readOnly} onChange={(e) => patch({ backups: Math.min(meta.limits.maxBackups, Math.max(0, Number(e.target.value) || 0)) })} />
          </Field>
        </div>
      </Section>

      <Section index={4} title="Qatnashishni tasdiqlash (ixtiyoriy)">
        <Notice tone="info">
          Instagram har bir izohga faqat <b>bitta</b> shaxsiy javob (DM) ruxsat beradi. Shu sababli «Qatnashishingiz qabul qilindi» xabarini giveaway emas, Comment 2.0
          kampaniyasining o&apos;zi yuboradi. Bu yerda tanlangan kampaniya faqat belgi (yorliq) vazifasini bajaradi: qaysi kampaniya qatnashishni tasdiqlashini ko&apos;rsatadi.
          Giveaway hech qanday xabar yubormaydi va kampaniyani o&apos;zgartirmaydi.
        </Notice>
        <Field label="Comment 2.0 kampaniyasi" hint={campaigns.length === 0 && form.accountId ? "Bu akkaunt uchun izoh kampaniyasi yo'q. Tasdiqsiz ham ishlayveradi." : "Faqat yorliq: DM'ni shu kampaniyaning o'zi yuboradi, giveaway emas."}>
          <select className={inputClass} value={form.confirmCampaignId} disabled={readOnly || !form.accountId} onChange={(e) => patch({ confirmCampaignId: e.target.value })}>
            <option value="">Tasdiqlamaslik</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? "" : " (o'chiq)"}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryButton} disabled={busy || readOnly || !ready || (Boolean(giveaway) && !dirty)} onClick={() => void save()}>
          {busy ? "Saqlanmoqda…" : giveaway ? "O'zgarishlarni saqlash" : "Qoralama sifatida saqlash"}
        </button>
        {!ready && !readOnly && <span className="self-center text-xs text-muted">Nom, akkaunt va postni tanlang.</span>}
      </div>
    </div>
  );
}
