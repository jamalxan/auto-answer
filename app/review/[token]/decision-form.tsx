"use client";

import { useState } from "react";

type State = { state: "open" | "decided" | "closed"; decision: "APPROVED" | "REJECTED" | null; comment: string | null };

/** Approve / Reject for the external reviewer; a rejection needs a comment (FR-A5). */
export default function DecisionForm({ token, initial }: { token: string; initial: State }) {
  const [view, setView] = useState<State>(initial);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(decision: "APPROVED" | "REJECTED") {
    if (decision === "REJECTED" && !comment.trim()) {
      setError("Rad etish uchun izoh yozing — nima o'zgarishi kerak?");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/content/reviews/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, comment: comment.trim() || undefined }),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; data?: State; error?: string } | null;
      if (!res.ok || !json?.success || !json.data) {
        setError(res.status === 404 ? "Havola eskirgan yoki post o'zgartirilgan." : (json?.error ?? "Yuborilmadi — qayta urinib ko'ring"));
        return;
      }
      setView({ state: json.data.state, decision: json.data.decision, comment: json.data.comment });
    } catch {
      setError("Tarmoq xatosi — qayta urinib ko'ring");
    } finally {
      setBusy(false);
    }
  }

  if (view.state === "decided") {
    const approved = view.decision === "APPROVED";
    return (
      <div className={`rounded-2xl p-4 text-sm ${approved ? "bg-success/12 text-success" : "bg-error/12 text-error"}`} role="status">
        <p className="font-semibold">{approved ? "Rahmat! Post tasdiqlandi." : "Post rad etildi — muallifga izohingiz yuborildi."}</p>
        {view.comment && <p className="mt-1 whitespace-pre-wrap text-foreground/85">{view.comment}</p>}
      </div>
    );
  }
  if (view.state === "closed") {
    return (
      <div className="inset p-4 text-sm text-muted" role="status">
        Bu post allaqachon ko&apos;rib chiqilgan — sizdan boshqa harakat talab qilinmaydi.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block text-xs font-semibold text-muted" htmlFor="review-comment">
        Izoh (rad etishda majburiy)
      </label>
      <textarea
        id="review-comment"
        className="input min-h-24 w-full"
        maxLength={2000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Masalan: rasm xira, narxni olib tashlang…"
      />
      {error && (
        <p className="rounded-2xl bg-error/12 px-4 py-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-lime" disabled={busy} onClick={() => void send("APPROVED")}>
          Tasdiqlash
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void send("REJECTED")}>
          Rad etish
        </button>
      </div>
    </div>
  );
}
