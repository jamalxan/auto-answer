/**
 * Stat Card
 *
 * Metric panel with label, value, and optional trend.
 */

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendUp?: boolean;
}

export default function StatCard({ label, value, trend, trendUp }: StatCardProps) {
  return (
    <div className="panel group relative overflow-hidden rounded-xl p-4 sm:p-5 hover:border-border-hover">
      {/* Accent hairline that lights up on hover. */}
      <span className="pointer-events-none absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-accent/60 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <p className="label-mono break-words text-[11px] leading-snug text-muted">{label}</p>
      <p className="mt-2 font-display text-2xl font-extrabold tabular-nums tracking-tight text-foreground sm:text-[1.75rem]">
        {value}
      </p>
      {trend && (
        <p
          className={`mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
            trendUp ? "bg-success/10 text-success" : "bg-error/10 text-error"
          }`}
        >
          {trendUp ? "↑" : "↓"} {trend}
        </p>
      )}
    </div>
  );
}
