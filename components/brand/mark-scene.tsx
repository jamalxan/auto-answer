/**
 * The logo assembling itself in 3D: comment bubble arrives from the top
 * left, the trigger pops lime, the DM bubble rises from the bottom right,
 * then the whole mark drifts slowly in perspective. Pure CSS, so it runs
 * on the server-rendered login page without a client bundle.
 *
 * Each part is a CSS shape with the bubble's own geometry plus a darker
 * copy sitting 18px behind it on the z-axis — real thickness once the
 * scene tilts.
 */

import type { LogoTone } from "@/components/logo-mark";

const TONES: Record<
  LogoTone,
  { comment: string; commentDeep: string; dm: string; dmDeep: string; trigger: string; triggerDeep: string }
> = {
  dark: {
    comment: "#FFFFFF",
    commentDeep: "#B9BBD6",
    dm: "#D4FF3A",
    dmDeep: "#9FC41A",
    trigger: "#6C4BFF",
    triggerDeep: "#4A2FD0",
  },
  violet: {
    comment: "#FFFFFF",
    commentDeep: "#C9C2FF",
    dm: "#D4FF3A",
    dmDeep: "#9FC41A",
    trigger: "#0A0B2E",
    triggerDeep: "#05061A",
  },
  light: {
    comment: "#0A0B2E",
    commentDeep: "#05061A",
    dm: "#6C4BFF",
    dmDeep: "#4A2FD0",
    trigger: "#D4FF3A",
    triggerDeep: "#9FC41A",
  },
};

export default function MarkScene({
  tone = "violet",
  className = "",
}: {
  tone?: LogoTone;
  className?: string;
}) {
  const c = TONES[tone];
  // Mark geometry in bubble units: bubble 1.2 × 1.0, DM offset 0.6 / 0.6,
  // overlap 0.6 × 0.4. Scene box: 1.8 × 1.6 units, rendered as a 9:8 box.
  return (
    <div
      aria-hidden="true"
      className={`relative mx-auto aspect-[9/8] w-full max-w-[26rem] [perspective:1400px] ${className}`}
    >
      <div className="absolute inset-0 [transform-style:preserve-3d] motion-safe:animate-[drift-3d_14s_ease-in-out_infinite]">
        {/* Comment bubble */}
        <div
          className="bubble-comment absolute left-0 top-0 h-[62.5%] w-[66.7%] [transform-style:preserve-3d] motion-safe:animate-[bubble-in-top_1.1s_cubic-bezier(0.16,1,0.3,1)_both]"
          style={{ transform: "translate3d(0,0,40px)" }}
        >
          <span
            className="bubble-comment absolute inset-0"
            style={{ background: c.commentDeep, transform: "translateZ(-18px)" }}
          />
          <span className="bubble-comment absolute inset-0" style={{ background: c.comment }} />
        </div>

        {/* DM bubble */}
        <div
          className="bubble-dm absolute bottom-0 right-0 h-[62.5%] w-[66.7%] [transform-style:preserve-3d] motion-safe:animate-[bubble-in-bottom_1.1s_cubic-bezier(0.16,1,0.3,1)_0.55s_both]"
          style={{ transform: "translate3d(0,0,120px)" }}
        >
          <span
            className="bubble-dm absolute inset-0"
            style={{ background: c.dmDeep, transform: "translateZ(-18px)" }}
          />
          <span className="bubble-dm absolute inset-0" style={{ background: c.dm }} />
        </div>

        {/* Trigger: the overlap */}
        <div
          className="absolute left-[33.3%] top-[37.5%] h-[25%] w-[33.4%] [transform-style:preserve-3d] motion-safe:animate-[trigger-pop_0.7s_cubic-bezier(0.16,1,0.3,1)_1.25s_both]"
          style={{ transform: "translate3d(0,0,150px)" }}
        >
          <span
            className="absolute inset-0"
            style={{ background: c.triggerDeep, transform: "translateZ(-18px)" }}
          />
          <span className="absolute inset-0" style={{ background: c.trigger }} />
        </div>
      </div>
    </div>
  );
}
