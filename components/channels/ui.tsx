/**
 * Small pieces shared by the Channels and Ads pages: the channel logo,
 * a date formatter and the flash notice, all on the brand tokens.
 */

import type { ReactNode } from "react";
import type { Flash } from "@/lib/flash";
import { Notice } from "@/components/assistant-ui";
import { BrandIcon } from "@/components/brand-icons";

export type ChannelKey = "facebook" | "threads" | "youtube";

export const CHANNEL_NAME: Record<ChannelKey, string> = { facebook: "Facebook", threads: "Threads", youtube: "YouTube" };

/** Every network the workspace can connect; Instagram and Telegram have their own connect flows. */
export type NetworkKey = "instagram" | ChannelKey | "telegram";
export const NETWORK_NAME: Record<NetworkKey, string> = { instagram: "Instagram", ...CHANNEL_NAME, telegram: "Telegram" };

/** The platform's real logo on a quiet tile, so five networks side by side stay calm. */
export function ChannelMark({ channel, size = "md" }: { channel: NetworkKey; size?: "sm" | "md" | "lg" }) {
  const box = size === "sm" ? "h-8 w-8 rounded-xl" : size === "lg" ? "h-14 w-14 rounded-2xl" : "h-11 w-11 rounded-2xl";
  const icon = size === "sm" ? "h-[18px] w-[18px]" : size === "lg" ? "h-8 w-8" : "h-6 w-6";
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center bg-white/[0.06] ring-1 ring-inset ring-white/10 ${box}`}>
      <BrandIcon brand={channel} className={icon} />
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
