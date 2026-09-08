"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";

interface InvitationAcceptCardProps {
  token: string;
  isSignedIn: boolean;
  invitedEmail: string;
}

export default function InvitationAcceptCard({
  token,
  isSignedIn,
  invitedEmail,
}: InvitationAcceptCardProps) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function acceptInvite() {
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/workspace/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const payload = await response.json();
    if (payload.success) {
      window.location.assign("/dashboard");
      return;
    }
    setMessage(payload.error ?? t.invite.errorCouldNotAccept);
    setBusy(false);
  }

  if (!isSignedIn) {
    return (
      <a
        href="/login"
        className="inline-flex items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-background transition hover:bg-accent-hover"
      >
        {t.invite.signInToAccept}
      </a>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={acceptInvite}
        disabled={busy}
        className="inline-flex items-center justify-center rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-background transition hover:bg-accent-hover disabled:opacity-50"
      >
        {busy ? t.invite.accepting : t.invite.accept}
      </button>
      {message && <p className="text-sm text-error">{message}</p>}
      <p className="text-xs text-muted">{t.invite.useMagicLinkFor(invitedEmail)}</p>
    </div>
  );
}

