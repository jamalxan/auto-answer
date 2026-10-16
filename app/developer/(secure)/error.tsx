"use client";

// Last-resort boundary for the developer screens: a transient server/DB error
// shows a retry instead of a blank 5xx page.
export default function DeveloperError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="panel mx-auto max-w-md space-y-3 rounded-xl p-6 text-center" role="alert">
      <h1 className="text-base font-semibold text-foreground">Sahifa vaqtincha ochilmadi</h1>
      <p className="text-sm text-muted">Server band yoki ulanish uzildi. Bir necha soniyadan keyin qayta urinib ko&apos;ring.</p>
      <button type="button" onClick={reset} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-hover">
        Qayta urinish
      </button>
    </div>
  );
}
