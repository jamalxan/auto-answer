"use client";

/**
 * "Qayerga joylaymiz?": the post's networks first, then the accounts of each
 * chosen network. Every network is equal here: Instagram is one chip among
 * Facebook, Threads, YouTube and Telegram. Instagram takes one account (the
 * post's own publish pipeline); the others take any number of accounts as
 * cross-post targets. A network that cannot take the post (YouTube without a
 * video, a Story anywhere but Instagram) is greyed with the reason.
 */

import { channelBlocker, formatFor, type CrossChannel } from "@/lib/content/platform-preview";
import type { PostTypeValue } from "@/lib/content/schema";
import type { ContentMeta } from "./shared";
import { BrandIcon } from "@/components/brand-icons";

export type TargetNetwork = CrossChannel | "telegram";
export type PickerNetwork = "instagram" | TargetNetwork;
export type CrossSelection = Record<TargetNetwork, string[]>;

export const EMPTY_CROSS: CrossSelection = { facebook: [], threads: [], youtube: [], telegram: [] };
/** Targets saved through /api/channels/targets (the credential vault). */
export const CROSS_CHANNELS: CrossChannel[] = ["facebook", "threads", "youtube"];
export const TARGET_NETWORKS: TargetNetwork[] = ["facebook", "threads", "youtube", "telegram"];
export const PICKER_NETWORKS: PickerNetwork[] = ["instagram", ...TARGET_NETWORKS];

export const NETWORK_NAME: Record<PickerNetwork, string> = { instagram: "Instagram", facebook: "Facebook", threads: "Threads", youtube: "YouTube", telegram: "Telegram" };
const FORMAT_NOTE: Record<string, string> = { reel: "Reels sifatida", short: "Shorts sifatida", video: "video sifatida", image: "rasm sifatida", carousel: "karusel sifatida", text: "matn sifatida" };

export function countTargets(sel: CrossSelection): number {
  return TARGET_NETWORKS.reduce((n, k) => n + sel[k].length, 0);
}

export function blockerFor(network: TargetNetwork, type: PostTypeValue, hasMedia: boolean): string | null {
  if (network === "telegram") return type === "STORY" ? "Story Telegram'ga chiqmaydi" : null;
  return channelBlocker(network, type, hasMedia);
}

export function NetworkDot({ network, className = "" }: { network: PickerNetwork; className?: string }) {
  return <BrandIcon brand={network} className={`h-4 w-4 shrink-0 ${className}`} />;
}

export default function NetworkPicker({
  meta,
  networks,
  onNetworks,
  instagramAccountId,
  onInstagram,
  value,
  onChange,
  type,
  hasMedia,
  instagramLocked,
  disabled,
}: {
  meta: ContentMeta;
  /** The chosen networks (chips that are on). */
  networks: PickerNetwork[];
  onNetworks: (next: PickerNetwork[]) => void;
  instagramAccountId: string | null;
  onInstagram: (id: string | null) => void;
  value: CrossSelection;
  onChange: (next: CrossSelection) => void;
  type: PostTypeValue;
  hasMedia: boolean;
  /** An existing post keeps its Instagram account (its jobs are tied to it). */
  instagramLocked: boolean;
  disabled?: boolean;
}) {
  const accountsOf = (n: PickerNetwork) =>
    n === "instagram" ? meta.accounts.map((a) => ({ id: a.id, label: `@${a.username}`, warn: a.tokenStatus !== "ACTIVE" ? "ulanish uzilgan" : !a.canPublish ? "publish ruxsati yo'q" : null })) : meta.networkAccounts.filter((a) => a.network === n).map((a) => ({ id: a.id, label: a.label, warn: null }));

  const toggleNetwork = (n: PickerNetwork) => {
    if (disabled) return;
    const on = networks.includes(n);
    if (n === "instagram") {
      if (instagramLocked) return;
      onInstagram(on ? null : (meta.accounts[0]?.id ?? null));
    } else if (on) {
      onChange({ ...value, [n]: [] });
    } else {
      // Turning a network on picks its only account, so one tap is enough in the common case.
      const list = accountsOf(n);
      if (list.length === 1 && !blockerFor(n, type, hasMedia)) onChange({ ...value, [n]: [list[0].id] });
    }
    onNetworks(on ? networks.filter((x) => x !== n) : [...networks, n]);
  };

  const toggleAccount = (n: TargetNetwork, id: string) => {
    const has = value[n].includes(id);
    onChange({ ...value, [n]: has ? value[n].filter((x) => x !== id) : [...value[n], id] });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tarmoqlar">
        {PICKER_NETWORKS.map((n) => {
          const count = accountsOf(n).length;
          const on = networks.includes(n);
          const off = count === 0;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              disabled={disabled || off || (n === "instagram" && instagramLocked)}
              onClick={() => toggleNetwork(n)}
              title={off ? `${NETWORK_NAME[n]} ulanmagan` : undefined}
              className={`inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-semibold transition-colors ${
                on ? "bg-violet text-white" : off ? "bg-white/5 text-muted/60" : "bg-white/8 text-cloud hover:bg-white/14"
              } disabled:cursor-not-allowed`}
            >
              <NetworkDot network={n} />
              {NETWORK_NAME[n]}
              <span className={`text-xs font-medium ${on ? "text-white/75" : "text-muted"}`}>{off ? "ulanmagan" : count}</span>
            </button>
          );
        })}
      </div>

      {networks.length === 0 && (
        <p className="text-xs text-muted">
          Post qaysi tarmoqqa chiqishini tanlang. Ulanmagan tarmoqni{" "}
          <a href="/channels" className="text-accent underline">
            Kanallar
          </a>{" "}
          bo&apos;limida ulang.
        </p>
      )}

      {PICKER_NETWORKS.filter((n) => networks.includes(n)).map((n) => {
        const list = accountsOf(n);
        const blocker = n === "instagram" ? null : blockerFor(n, type, hasMedia);
        return (
          <div key={n} className="inset space-y-2 p-3">
            <div className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                <NetworkDot network={n} />
                {NETWORK_NAME[n]}
              </span>
              <span className={blocker ? "text-warning" : "text-muted"}>
                {n === "instagram"
                  ? instagramLocked
                    ? "Saqlangan postning Instagram akkaunti o'zgarmaydi"
                    : "Bitta akkaunt tanlanadi"
                  : (blocker ?? (n === "telegram" ? "Kanalga post sifatida chiqadi" : `${FORMAT_NOTE[formatFor(type, n, hasMedia)]} chiqadi`))}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {list.map((a) => {
                const on = n === "instagram" ? instagramAccountId === a.id : value[n].includes(a.id);
                const lock = disabled || Boolean(blocker) || (n === "instagram" && instagramLocked);
                return (
                  <label key={a.id} className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm ${on ? "bg-violet/25 text-white" : "bg-white/6 text-cloud"} ${lock ? "opacity-60" : "cursor-pointer hover:bg-white/10"}`}>
                    <input
                      type={n === "instagram" ? "radio" : "checkbox"}
                      name={n === "instagram" ? "ig-account" : undefined}
                      checked={on}
                      disabled={lock}
                      onChange={() => (n === "instagram" ? onInstagram(a.id) : toggleAccount(n, a.id))}
                      className="accent-violet"
                    />
                    {a.label}
                    {a.warn && <span className="text-xs text-warning">· {a.warn}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
