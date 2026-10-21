"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Icon from "@/components/icons";

export interface HeroDemoCopy {
  username: string;
  keyword: string;
  typeHint: string;
  waiting: string;
  matched: string;
  reply: string;
  sentIn: string;
  via: string;
  now: string;
  /** Label above the comment card, e.g. "Comment trigger". */
  triggerLabel: string;
  /** Label above the DM card, e.g. "Private reply". */
  replyLabel: string;
}

type Phase = "typing" | "waiting" | "matched" | "sent";

/**
 * The product, live, in the shape of its own logo.
 *
 * A real Instagram-style comment (the top bubble), the keyword match (the
 * lime trigger) and the DM that follows (the bottom bubble) stand in a
 * perspective scene that tilts toward the cursor. On load the sequence
 * plays by itself: the keyword types into the comment, the trigger pops,
 * the DM arrives a second later. Then the visitor can type anything: a
 * comment containing the keyword sends the DM again; anything else waits.
 *
 * Without JavaScript the finished state renders server-side.
 */
export default function HeroDemo({ copy }: { copy: HeroDemoCopy }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [comment, setComment] = useState(copy.keyword);
  const [phase, setPhase] = useState<Phase>("sent");
  const [autoplayed, setAutoplayed] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  // Autoplay once after mount: type the keyword, match, send.
  useEffect(() => {
    const word = copy.keyword;
    let i = 0;
    const step = () => {
      i += 1;
      setComment(word.slice(0, i));
      if (i < word.length) {
        timers.current.push(window.setTimeout(step, 110));
      } else {
        timers.current.push(window.setTimeout(() => setPhase("matched"), 350));
        timers.current.push(window.setTimeout(() => setPhase("sent"), 1350));
        timers.current.push(window.setTimeout(() => setAutoplayed(true), 1400));
      }
    };
    // State changes start from a timer callback, never synchronously in the
    // effect body: the server-rendered finished state paints first.
    timers.current.push(
      window.setTimeout(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setAutoplayed(true);
          return;
        }
        setComment("");
        setPhase("typing");
        timers.current.push(window.setTimeout(step, 600));
      }, 350)
    );
    return clearTimers;
    // The keyword is locale-bound and stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Visitor input: match → send, or wait.
  const onInput = (value: string) => {
    setComment(value);
    if (!autoplayed) return;
    clearTimers();
    const hit = value.toLowerCase().includes(copy.keyword.toLowerCase());
    if (!hit) {
      setPhase(value.trim() ? "waiting" : "typing");
      return;
    }
    setPhase("matched");
    timers.current.push(window.setTimeout(() => setPhase("sent"), 1000));
  };

  // Pointer tilt for the whole scene.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    if (
      !window.matchMedia("(hover: hover) and (pointer: fine)").matches ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const area = el.parentElement ?? el;
    let raf = 0;
    let rx = 0;
    let ry = 0;
    const paint = () => {
      el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      raf = 0;
    };
    const move = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      ry = px * 14;
      rx = -py * 12;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const leave = () => {
      rx = 0;
      ry = 0;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerleave", leave);
    return () => {
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerleave", leave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const matched = phase === "matched" || phase === "sent";
  const sent = phase === "sent";
  const initial = copy.username.charAt(0).toUpperCase();

  return (
    <div className="relative mx-auto w-full max-w-[34rem] [perspective:1500px]">
      <div
        ref={stageRef}
        className="relative aspect-[3/4] w-full transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] [transform-style:preserve-3d] sm:aspect-[6/5]"
      >
        {/* Comment bubble — top left, points bottom-right like the mark.
            Each card is a front face plus a darker face 16px behind it, so
            the tilt reveals real thickness. */}
        <article
          className="bubble-comment absolute left-0 top-0 w-[76%] text-midnight [transform-style:preserve-3d] motion-safe:animate-[bubble-in-top_1s_cubic-bezier(0.16,1,0.3,1)_both]"
          style={{ transform: "translate3d(0,0,40px)" }}
        >
          <span
            aria-hidden="true"
            className="bubble-comment absolute inset-0 bg-[#C9CBE3]"
            style={{ transform: "translateZ(-16px)" }}
          />
          <span
            aria-hidden="true"
            className="bubble-comment absolute inset-0 bg-white shadow-[0_34px_60px_-28px_rgb(0_0_0/0.7)]"
            style={{ transform: "translateZ(0)" }}
          />
          <div className="relative px-6 pb-7 pt-6 sm:px-8 sm:pb-9 sm:pt-7" style={{ transform: "translateZ(1px)" }}>
            <p className="text-sm font-semibold text-slate">{copy.triggerLabel}</p>
            <div className="mt-4 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-violet font-display text-base font-semibold text-white">
                {initial}
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold">@{copy.username}</p>
                <p className="text-sm text-slate">{copy.now}</p>
              </div>
              <span className="ml-auto text-slate">
                <Icon name="instagram" className="h-5 w-5" />
              </span>
            </div>
            <label className="mt-4 block">
              <span className="sr-only">{copy.typeHint}</span>
              <input
                value={comment}
                onChange={(e) => onInput(e.target.value)}
                placeholder={copy.typeHint}
                maxLength={60}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-full bg-cloud px-5 py-3 text-base text-midnight placeholder:text-slate/80 focus-visible:shadow-[0_0_0_3px_rgb(108_75_255/0.35)]"
              />
            </label>
          </div>
        </article>

        {/* Trigger — the overlap. Lime when matched, waits otherwise. */}
        <div
          className="absolute left-[28%] top-[47%] [transform-style:preserve-3d] sm:left-[34%] sm:top-[44%]"
          style={{ transform: "translate3d(0,0,150px)" }}
        >
          <div
            key={matched ? "on" : "off"}
            className={`relative [transform-style:preserve-3d] ${
              matched ? "motion-safe:animate-[trigger-pop_0.6s_cubic-bezier(0.16,1,0.3,1)_both]" : ""
            }`}
          >
            <span
              aria-hidden="true"
              className={`absolute inset-0 rounded-full ${matched ? "bg-lime-deep" : "bg-midnight"}`}
              style={{ transform: "translateZ(-14px)" }}
            />
            <span
              className={`relative flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold shadow-[0_20px_40px_-18px_rgb(0_0_0/0.7)] ${
                matched ? "bg-lime text-midnight" : "bg-surface-hover text-muted"
              }`}
              style={{ transform: "translateZ(0)" }}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${matched ? "bg-midnight" : "bg-muted/60"}`}
              />
              {matched ? copy.matched : copy.waiting}
            </span>
          </div>
        </div>

        {/* DM bubble — bottom right, points top-left like the mark. */}
        <article
          className={`bubble-dm absolute bottom-0 right-0 w-[78%] text-white [transform-style:preserve-3d] transition-all duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] ${
            sent ? "opacity-100" : "opacity-0"
          }`}
          style={
            {
              transform: sent ? "translate3d(0,0,120px)" : "translate3d(0,32px,120px)",
            } as CSSProperties
          }
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="bubble-dm absolute inset-0 bg-violet-deep"
            style={{ transform: "translateZ(-16px)" }}
          />
          <span
            aria-hidden="true"
            className="bubble-dm absolute inset-0 bg-violet shadow-[0_40px_70px_-28px_rgb(0_0_0/0.75)]"
            style={{ transform: "translateZ(0)" }}
          />
          <div className="relative px-6 pb-6 pt-8 sm:px-8 sm:pb-7 sm:pt-9" style={{ transform: "translateZ(1px)" }}>
            <p className="text-sm font-semibold text-white/75">{copy.replyLabel}</p>
            <p className="mt-3 text-[1.05rem] leading-7">{copy.reply}</p>
            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-white/80">
              <span className="inline-flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-lime" />
                {copy.sentIn}
              </span>
              <span aria-hidden="true">·</span>
              <span>{copy.via}</span>
            </div>
          </div>
        </article>
      </div>
    </div>
  );
}
