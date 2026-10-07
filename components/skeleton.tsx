/**
 * Shared loading-state primitive. Before this, "loading" looked different on
 * every page — static gray blocks on the dashboard, plain "Loading…" text on
 * the inbox, nothing at all elsewhere. One block + one animation, reused,
 * instead of each page inventing its own.
 */
export default function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-shimmer rounded bg-surface-hover bg-[length:200%_100%] bg-[linear-gradient(90deg,transparent_25%,rgb(255_255_255/0.06)_50%,transparent_75%)] ${className}`}
    />
  );
}
