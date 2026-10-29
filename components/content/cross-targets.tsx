"use client";

/**
 * "Boshqa tarmoqlarga ham": pick the Facebook / Threads / YouTube accounts that
 * get this post at the same slot (cross-post targets). A channel that cannot take
 * the post (YouTube without a video, a Story anywhere) is greyed with the reason.
 */

import { useEffect, useState } from "react";
import { channelBlocker, formatFor, PLATFORM_LABEL, type CrossChannel } from "@/lib/content/platform-preview";
import type { PostTypeValue } from "@/lib/content/schema";
import { requestJson } from "./shared";

export interface CrossCredential {
  id: string;
  channel: string;
  label: string | null;
  status: string;
}

export type CrossSelection = Record<CrossChannel, string[]>;

export const EMPTY_CROSS: CrossSelection = { facebook: [], threads: [], youtube: [] };
export const CROSS_CHANNELS: CrossChannel[] = ["facebook", "threads", "youtube"];

const FORMAT_NOTE: Record<string, string> = { reel: "Reels sifatida", short: "Shorts sifatida", video: "video sifatida", image: "rasm sifatida", carousel: "karusel sifatida", text: "matn sifatida" };

export function useCrossCredentials() {
  const [creds, setCreds] = useState<CrossCredential[] | null>(null);
  useEffect(() => {
    let alive = true;
    void requestJson<{ credentials: CrossCredential[] }>("/api/channels/credentials").then((res) => {
      if (alive) setCreds(res.ok ? res.data.credentials.filter((c) => c.status === "ACTIVE" || c.status === "EXPIRING") : []);
    });
    return () => {
      alive = false;
    };
  }, []);
  return creds;
}

export default function CrossTargets({
  creds,
  value,
  onChange,
  type,
  hasMedia,
  disabled,
}: {
  creds: CrossCredential[] | null;
  value: CrossSelection;
  onChange: (next: CrossSelection) => void;
  type: PostTypeValue;
  hasMedia: boolean;
  disabled?: boolean;
}) {
  if (creds === null) return <p className="text-xs text-muted">Ulangan tarmoqlar yuklanmoqda…</p>;
  const groups = CROSS_CHANNELS.map((channel) => ({ channel, accounts: creds.filter((c) => c.channel === channel) })).filter((g) => g.accounts.length > 0);
  if (groups.length === 0) {
    return (
      <p className="text-xs text-muted">
        Facebook, Threads yoki YouTube ulanmagan. <a href="/channels" className="text-accent underline">Kanallar</a> bo&apos;limida ulang — keyin video shu yerdan hammasiga birga rejalashtiriladi.
      </p>
    );
  }
  const toggle = (channel: CrossChannel, id: string) => {
    const has = value[channel].includes(id);
    onChange({ ...value, [channel]: has ? value[channel].filter((x) => x !== id) : [...value[channel], id] });
  };
  return (
    <div className="space-y-3">
      {groups.map(({ channel, accounts }) => {
        const blocker = channelBlocker(channel, type, hasMedia);
        return (
          <div key={channel}>
            <div className="mb-1 flex flex-wrap items-baseline gap-2 text-xs">
              <span className="font-semibold text-foreground">{PLATFORM_LABEL[channel]}</span>
              <span className="text-muted">{blocker ?? `${FORMAT_NOTE[formatFor(type, channel, hasMedia)]} chiqadi`}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {accounts.map((a) => {
                const on = value[channel].includes(a.id);
                return (
                  <label key={a.id} className={`inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${on ? "border-accent/60 bg-accent/10" : "border-border"} ${blocker || disabled ? "opacity-50" : "cursor-pointer"}`}>
                    <input type="checkbox" checked={on} disabled={Boolean(blocker) || disabled} onChange={() => toggle(channel, a.id)} />
                    {a.label ?? PLATFORM_LABEL[channel]}
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
