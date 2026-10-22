/**
 * Stat Card
 *
 * Metric tile: sentence-case label, display number, optional trend pill.
 */

interface StatCardProps {
  label: string;
  value: string | number;
  trend?: string;
  trendUp?: boolean;
}

export default function StatCard({ label, value, trend, trendUp }: StatCardProps) {
  return (
    <div className="panel rounded-2xl p-4 sm:p-5">
      <p className="break-words text-xs font-semibold leading-snug text-muted">{label}</p>
      <p className="display mt-3 text-2xl tabular-nums text-white sm:text-[1.75rem]">{value}</p>
      {trend && (
        <p
          className={`mt-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
            trendUp ? "bg-lime/15 text-lime" : "bg-error/15 text-error"
          }`}
        >
          {trendUp ? "↑" : "↓"} {trend}
        </p>
      )}
    </div>
  );
}
