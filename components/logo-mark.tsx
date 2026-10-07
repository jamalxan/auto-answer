/** Brand mark shown next to the "SocialAuto" wordmark in every header. */
export default function LogoMark({ className = "h-8 w-8 text-sm" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-[#6e5aff] font-display font-black text-background shadow-[0_4px_16px_-4px_rgb(0_240_181/0.5)] ${className}`}
    >
      S
    </span>
  );
}
