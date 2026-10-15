/**
 * Small helpers shared by the foundation loaders and builders. Pure.
 */

// The shared Redis client retries forever, so a Redis outage would hang a
// status page instead of reporting it. null = "could not find out".
export function withTimeout<T>(promise: Promise<T>, ms = 2000): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "hozirgina", "5 daqiqa oldin", "3 soat oldin", "2 kun oldin". */
export function formatAgo(value: Date | string | null | undefined, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return "—";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "hozirgina";
  if (minutes < 60) return `${minutes} daqiqa oldin`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} soat oldin`;
  return `${Math.floor(hours / 24)} kun oldin`;
}

/** 12 → "12 daqiqa", 90 → "1 soat 30 daqiqa", 0 → "0 daqiqa". */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.ceil(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} daqiqa`;
  return rest === 0 ? `${hours} soat` : `${hours} soat ${rest} daqiqa`;
}
