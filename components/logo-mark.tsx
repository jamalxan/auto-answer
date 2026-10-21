/**
 * SocialAuto brand mark — the two chat bubbles (comment on top, DM below)
 * whose overlap is the trigger. Geometry is the kit's own SVG
 * (01-Belgi/SVG), colours follow the brand book's per-background rules:
 *
 *   dark   (navy / black)  → white comment, lime DM, violet trigger
 *   light  (white / cloud) → navy comment, violet DM, lime trigger
 *   violet (#6C4BFF)       → white comment, lime DM, navy trigger
 */

export type LogoTone = "dark" | "light" | "violet";

const TONES: Record<LogoTone, { comment: string; dm: string; trigger: string }> = {
  dark: { comment: "#FFFFFF", dm: "#D4FF3A", trigger: "#6C4BFF" },
  light: { comment: "#0A0B2E", dm: "#6C4BFF", trigger: "#D4FF3A" },
  violet: { comment: "#FFFFFF", dm: "#D4FF3A", trigger: "#0A0B2E" },
};

export const MARK_PATHS = {
  comment:
    "M312.5,0h125c172.58898,0 312.5,139.91102 312.5,312.5l0,62.5h-375v250h-62.5c-172.58898,0 -312.5,-139.91102 -312.5,-312.5c0,-172.58898 139.91102,-312.5 312.5,-312.5z",
  dm: "M812.5,375c172.58898,0 312.5,139.91102 312.5,312.5c0,172.58898 -139.91102,312.5 -312.5,312.5h-125c-172.58898,0 -312.5,-139.91102 -312.5,-312.5l0,-62.5h375l0,-250z",
  trigger: "M750,625h-375v-250l375,0z",
};

export default function LogoMark({
  className = "h-8 w-8",
  tone = "dark",
  title,
}: {
  className?: string;
  tone?: LogoTone;
  /** Accessible name; omit when a visible wordmark sits next to it. */
  title?: string;
}) {
  const c = TONES[tone];
  return (
    <svg
      viewBox="0 0 1125 1000"
      className={`shrink-0 ${className}`}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <path d={MARK_PATHS.comment} fill={c.comment} />
      <path d={MARK_PATHS.dm} fill={c.dm} />
      <path d={MARK_PATHS.trigger} fill={c.trigger} />
    </svg>
  );
}

/**
 * Horizontal lockup: mark + "SocialAuto" set in Unbounded 600 at −40
 * tracking, with "Auto" always in the accent colour, as the brand book
 * specifies. Text rather than outlines so it stays crisp at every size.
 */
export function Wordmark({
  tone = "dark",
  className = "",
  markClassName = "h-8 w-8",
  textClassName = "text-[1.15rem]",
}: {
  tone?: LogoTone;
  className?: string;
  markClassName?: string;
  textClassName?: string;
}) {
  const social = tone === "light" ? "text-midnight" : "text-white";
  const auto = tone === "light" ? "text-violet" : "text-lime";
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark tone={tone} className={markClassName} />
      <span
        className={`font-display font-semibold leading-none tracking-[-0.04em] ${social} ${textClassName}`}
      >
        Social<span className={auto}>Auto</span>
      </span>
    </span>
  );
}
