/**
 * Small pieces shared by the Channels and Ads pages: the channel monogram,
 * a date formatter and the flash notice, all on the brand tokens.
 */

import type { ReactNode } from "react";
import type { Flash } from "@/lib/flash";
import { Notice } from "@/components/assistant-ui";

export type ChannelKey = "facebook" | "threads" | "youtube";

export const CHANNEL_NAME: Record<ChannelKey, string> = { facebook: "Facebook", threads: "Threads", youtube: "YouTube" };

const MARK: Record<ChannelKey, { glyph: string; cls: string }> = {
  facebook: { glyph: "f", cls: "bg-[#1877f2] text-white" },
  threads: { glyph: "@", cls: "bg-white text-midnight" },
  youtube: { glyph: "▶", cls: "bg-[#ff0033] text-white" },
};

/** A rounded monogram stands in for each platform's logo. */
export function ChannelMark({ channel, size = "md" }: { channel: ChannelKey; size?: "sm" | "md" }) {
  const { glyph, cls } = MARK[channel];
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-2xl font-bold ${cls} ${size === "sm" ? "h-7 w-7 text-sm" : "h-11 w-11 text-xl"}`}>
      {glyph}
    </span>
  );
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("uz-UZ", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function FlashNotice({ flash }: { flash: Flash | null }): ReactNode {
  return flash ? <Notice tone={flash.tone}>{flash.text}</Notice> : null;
}

/** Underline-free tab row: the active chip is the violet nav pill. */
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: ReadonlyArray<readonly [T, string, number?]>; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist">
      {tabs.map(([key, label, count]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} onClick={() => onChange(key)} className={`chip shrink-0 ${value === key ? "chip-active" : ""}`}>
          {label}
          {count !== undefined && count > 0 && <span className="rounded-full bg-white/15 px-1.5 text-xs">{count}</span>}
        </button>
      ))}
    </div>
  );
}
