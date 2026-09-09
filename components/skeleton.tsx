/**
 * Shared loading-state primitive. Before this, "loading" looked different on
 * every page — static gray blocks on the dashboard, plain "Loading…" text on
 * the inbox, nothing at all elsewhere. One block + one animation, reused,
 * instead of each page inventing its own.
 */
export default function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-hover ${className}`} />;
}
