"use client";

/**
 * FR-L1: the composer's "Yangi kampaniya" — a comment-to-DM campaign typed
 * next to the post. It is sent with the post body as `linkCampaign.create`;
 * the server builds it with the dashboard's own campaign writer
 * (lib/campaigns/create-automation) and parks it on the post, switched off,
 * until the post goes out.
 */

import { ChipInput, Field, inputClass, Toggle } from "@/components/developer/ui";
import type { NewCampaignDraft } from "./shared";

export const EMPTY_NEW_CAMPAIGN: NewCampaignDraft = { keywords: [], publicReply: "", dmMessage: "", link: "", linkButtonLabel: "", requireFollow: false };

/** The client-side twin of newCampaignSchema's required fields (the server re-checks). */
export function newCampaignIssue(c: NewCampaignDraft): string | null {
  if (c.keywords.filter((k) => k.trim()).length === 0) return "Kamida bitta kalit so'z kiriting";
  if (!c.dmMessage.trim()) return "DM matnini kiriting";
  if (c.link.trim() && !/^https?:\/\/\S+$/i.test(c.link.trim())) return "Havola https:// bilan boshlansin";
  return null;
}

/** The API shape: empty optional fields dropped. */
export function newCampaignBody(c: NewCampaignDraft) {
  return {
    keywords: c.keywords,
    dmMessage: c.dmMessage,
    ...(c.publicReply.trim() ? { publicReply: c.publicReply } : {}),
    ...(c.link.trim() ? { link: c.link.trim(), ...(c.linkButtonLabel.trim() ? { linkButtonLabel: c.linkButtonLabel } : {}) } : {}),
    requireFollow: c.requireFollow,
  };
}

export default function NewCampaignFields({ value, onChange }: { value: NewCampaignDraft; onChange: (next: NewCampaignDraft) => void }) {
  const set = (patch: Partial<NewCampaignDraft>) => onChange({ ...value, ...patch });
  const issue = newCampaignIssue(value);
  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <Field label="Kalit so'zlar" hint="Kommentda shu so'z bo'lsa, DM yuboriladi. Enter bilan qo'shing.">
        <ChipInput values={value.keywords} onChange={(keywords) => set({ keywords: keywords.slice(0, 10) })} placeholder="masalan: narx" />
      </Field>
      <Field label="Ochiq javob (ixtiyoriy)" hint="Komment ostida ko'rinadigan javob.">
        <input className={inputClass} value={value.publicReply} maxLength={1000} onChange={(e) => set({ publicReply: e.target.value })} placeholder="DM'ga yubordik" />
      </Field>
      <Field label="DM matni">
        <textarea className={`${inputClass} min-h-20`} value={value.dmMessage} maxLength={1000} onChange={(e) => set({ dmMessage: e.target.value })} placeholder="Salom! Mana siz so'ragan ma'lumot…" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <Field label="Havola (ixtiyoriy)" hint="DM'da tugma bo'lib chiqadi, bosishlar hisoblanadi.">
          <input className={inputClass} value={value.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://" inputMode="url" />
        </Field>
        <Field label="Tugma nomi">
          <input className={inputClass} value={value.linkButtonLabel} maxLength={20} onChange={(e) => set({ linkButtonLabel: e.target.value })} placeholder="Ochish" disabled={!value.link.trim()} />
        </Field>
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-foreground">
        <div>
          Faqat obunachilarga
          <p className="text-xs text-muted">Obuna bo&apos;lmaganlarga avval obuna bo&apos;lishni so&apos;raydi.</p>
        </div>
        <Toggle on={value.requireFollow} onChange={(requireFollow) => set({ requireFollow })} label="Faqat obunachilarga" />
      </div>
      {issue && <p className="text-xs text-warning">{issue}</p>}
    </div>
  );
}
