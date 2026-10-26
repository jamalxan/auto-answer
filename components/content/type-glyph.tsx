/**
 * Line icons of the post kinds (Post, Karusel, Reels, Story) and the badge
 * that pairs one with its label. Same 24-grid, 1.8 stroke as components/icons.
 */

import type { SVGProps } from "react";
import { GROUP_LABEL, TYPE_GROUP, type TypeGroup } from "./timeline";
import type { PostTypeValue } from "./shared";

const PATHS: Record<TypeGroup, React.ReactNode> = {
  post: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <path d="m4.5 16 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5" />
      <circle cx="15.5" cy="8.5" r="1.4" />
    </>
  ),
  carousel: (
    <>
      <rect x="3" y="6" width="13" height="13" rx="3" />
      <path d="M8 3.5h9.5A3.5 3.5 0 0 1 21 7v9.5" />
    </>
  ),
  reels: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="4" />
      <path d="m10.5 9.2 4.3 2.8-4.3 2.8z" fill="currentColor" stroke="none" />
    </>
  ),
  story: (
    <>
      <circle cx="12" cy="12" r="8.5" strokeDasharray="3.2 2.4" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
};

export function TypeGlyph({ group, ...props }: { group: TypeGroup } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {PATHS[group]}
    </svg>
  );
}

export const GROUP_BADGE: Record<TypeGroup, string> = {
  reels: "bg-violet/25 text-white",
  story: "bg-lime/15 text-lime",
  post: "bg-white/[0.08] text-cloud",
  carousel: "bg-white/[0.08] text-cloud",
};

export function TypeBadge({ type }: { type: PostTypeValue }) {
  const group = TYPE_GROUP[type];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${GROUP_BADGE[group]}`}>
      <TypeGlyph group={group} width={14} height={14} />
      {type === "TRIAL_REEL" ? "Trial Reels" : type === "FEED_VIDEO" ? "Video post" : GROUP_LABEL[group]}
    </span>
  );
}
