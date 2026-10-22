"use client";

import { Suspense, useEffect, useState } from "react";
import type { AccountOption } from "@/components/account-select";
import { InstagramConnectNotice } from "@/components/instagram-connect-notice";
import { useLanguage } from "@/components/language-provider";
import { Card } from "@/components/ui/page";

interface SettingsData {
  workspace: {
    name: string;
    dmsSentThisPeriod: number;
    aiConversationsThisPeriod?: number;
    aiConversationsLimit?: number;
  };
  instagramAccount: {
    id: string;
    username: string;
    instagramId: string;
    tokenExpiresAt: string | null;
    tokenStatus?: "ACTIVE" | "BROKEN";
    webhookSubscribed: boolean;
  } | null;
  instagramAccounts: Array<
    AccountOption & {
      tokenExpiresAt: string | null;
      tokenStatus?: "ACTIVE" | "BROKEN";
      webhookSubscribed: boolean;
    }
  >;
}

interface WorkspaceMembersData {
  currentUserRole: "OWNER" | "ADMIN" | "MEMBER" | "MANAGER" | "OPERATOR" | "VIEWER";
  members: Array<{
    id: string;
    role: "OWNER" | "ADMIN" | "MEMBER" | "MANAGER" | "OPERATOR" | "VIEWER";
    createdAt: string;
    user: {
      id: string;
      email: string | null;
      name: string | null;
    };
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: "OWNER" | "ADMIN" | "MEMBER" | "MANAGER" | "OPERATOR" | "VIEWER";
    // Only sent to owners and admins.
    inviteUrl?: string;
    expiresAt: string;
  }>;
}

export default function SettingsPage() {
  const { t } = useLanguage();
  const [data, setData] = useState<SettingsData | null>(null);
  const [membersData, setMembersData] = useState<WorkspaceMembersData | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/dashboard/stats").then((res) => res.json()),
      fetch("/api/workspace/members").then((res) => res.json()),
    ])
      .then(([statsPayload, membersPayload]) => {
        if (statsPayload.success) setData(statsPayload.data);
        if (membersPayload.success) setMembersData(membersPayload.data);
      })
      .finally(() => setLoading(false));
  }, []);

  async function refreshMembers() {
    const res = await fetch("/api/workspace/members");
    const payload = await res.json();
    if (payload.success) setMembersData(payload.data);
  }

  async function disconnectInstagram(instagramAccountId: string) {
    if (!confirm(t.settings.confirmDisconnect)) {
      return;
    }

    setBusy(`disconnect:${instagramAccountId}`);
    await fetch("/api/instagram/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instagramAccountId }),
    });
    window.location.reload();
  }

  async function inviteMember(event: React.FormEvent) {
    event.preventDefault();
    setMemberError(null);
    setBusy("invite");
    const res = await fetch("/api/workspace/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const payload = await res.json();
    if (payload.success) {
      setMembersData(payload.data);
      setInviteEmail("");
    } else {
      setMemberError(payload.error ?? t.settings.inviteError);
    }
    setBusy(null);
  }

  async function removeInvitation(invitationId: string) {
    setBusy(`invite:${invitationId}`);
    await fetch("/api/workspace/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId }),
    });
    await refreshMembers();
    setBusy(null);
  }

  async function updateMemberRole(memberId: string, role: "ADMIN" | "MEMBER") {
    setMemberError(null);
    setBusy(`role:${memberId}`);
    const res = await fetch("/api/workspace/members", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, role }),
    });
    const payload = await res.json();
    if (payload.success) {
      setMembersData(payload.data);
    } else {
      setMemberError(payload.error ?? t.settings.inviteError);
    }
    setBusy(null);
  }

  async function removeMember(memberId: string) {
    if (!window.confirm(t.settings.confirmRemoveMember)) return;
    setMemberError(null);
    setBusy(`member:${memberId}`);
    const res = await fetch("/api/workspace/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId }),
    });
    const payload = await res.json();
    if (payload.success) {
      setMembersData(payload.data);
    } else {
      setMemberError(payload.error ?? t.settings.inviteError);
    }
    setBusy(null);
  }

  if (loading) {
    return <div className="panel h-64 animate-pulse rounded-3xl" />;
  }

  const accounts = data?.instagramAccounts ?? [];
  const hasBrokenToken = accounts.some((a) => a.tokenStatus === "BROKEN");
  const canManageMembers =
    membersData?.currentUserRole === "OWNER" ||
    membersData?.currentUserRole === "ADMIN";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Surfaces the ?instagram= code the OAuth routes redirect back with.
          Needs a Suspense boundary: useSearchParams in a prerendered client
          page fails the production build without one. */}
      <Suspense fallback={null}>
        <InstagramConnectNotice />
      </Suspense>

      <Card title={t.settings.instagramConnection}>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">{t.settings.status}</p>
              <p className="mt-0.5 text-xs text-muted">{t.settings.statusHelp}</p>
            </div>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${
                accounts.length > 0 && !hasBrokenToken
                  ? "bg-lime/15 text-lime"
                  : hasBrokenToken
                    ? "bg-error/15 text-error"
                    : "bg-warning/15 text-warning"
              }`}
            >
              {hasBrokenToken
                ? t.assistant.tokenStatus.broken
                : accounts.length > 0
                  ? t.settings.connected
                  : t.settings.notConnected}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">{t.settings.accounts}</p>
              <p className="mt-0.5 text-xs text-muted">
                {t.settings.accountsHelp(accounts.length)}
              </p>
            </div>
            <span className="text-sm text-muted">
              {accounts.length > 0
                ? t.settings.connectedCount(accounts.length)
                : t.settings.none}
            </span>
          </div>

          <div className="space-y-2">
            {accounts.length === 0 && (
              <p className="text-sm text-muted">{t.settings.connectPrompt}</p>
            )}
            {accounts.map((account) => {
              // 14/7/1-day heads-up so a token doesn't lapse silently — Meta
              // gives no other signal before automations just stop delivering.
              const daysUntilExpiry = account.tokenExpiresAt
                ? Math.ceil(
                    (new Date(account.tokenExpiresAt).getTime() - new Date().getTime()) /
                      (24 * 60 * 60 * 1000)
                  )
                : null;
              const expiringSoon = daysUntilExpiry !== null && daysUntilExpiry <= 14;

              return (
                <div
                  key={account.id}
                  className="inset flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-semibold text-white">
                      @{account.username}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {t.settings.tokenExpires(
                        account.tokenExpiresAt
                          ? new Date(account.tokenExpiresAt).toLocaleDateString()
                          : t.settings.notAvailable
                      )}{" "}
                      ·{" "}
                      {account.webhookSubscribed
                        ? t.settings.webhookReady
                        : t.settings.webhookPending}
                    </p>
                    {account.tokenStatus === "BROKEN" && (
                      <p className="mt-1 text-xs font-medium text-error">
                        {t.assistant.tokenStatus.brokenHelp}
                      </p>
                    )}
                    {expiringSoon && (
                      <p className="mt-1 text-xs font-medium text-warning">
                        {t.settings.tokenExpiringSoon(Math.max(daysUntilExpiry, 0))}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => disconnectInstagram(account.id)}
                    disabled={busy === `disconnect:${account.id}`}
                    className="btn btn-sm btn-danger shrink-0"
                  >
                    {busy === `disconnect:${account.id}`
                      ? t.settings.disconnecting
                      : t.settings.disconnect}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <a href="/api/instagram/connect" className="btn btn-sm btn-lime">
            {accounts.length > 0 ? t.settings.connectAnother : t.settings.connectInstagram}
          </a>
        </div>
      </Card>

      <Card title={t.settings.team}>
        <div className="space-y-2">
          {membersData?.members.map((member) => {
            // Owners aren't editable — canManageWorkspace already blocks the
            // API from touching an OWNER row, so there's nothing to offer here.
            const canEditThisMember = canManageMembers && member.role !== "OWNER";
            // The ADMIN / MEMBER picker only knows the production roles; a
            // MANAGER / OPERATOR / VIEWER (set in the CRM Team tab) is shown
            // read-only so a stray change cannot silently demote them.
            const roleEditable = member.role === "ADMIN" || member.role === "MEMBER";
            const roleLabel =
              member.role === "OWNER"
                ? t.settings.roleOwner
                : member.role === "ADMIN"
                  ? t.settings.roleAdmin
                  : member.role === "MANAGER"
                    ? t.settings.roleManager
                    : member.role === "OPERATOR"
                      ? t.settings.roleOperator
                      : member.role === "VIEWER"
                        ? t.settings.roleViewer
                        : t.settings.roleMember;
            const roleBadge = (
              <span className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-muted">
                {roleLabel}
              </span>
            );
            return (
              <div
                key={member.id}
                className="inset flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white">
                    {member.user.name ?? member.user.email ?? t.settings.unknownMember}
                  </p>
                  <p className="truncate text-xs text-muted">{member.user.email}</p>
                </div>
                {canEditThisMember ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {roleEditable ? (
                      <select
                        value={member.role}
                        disabled={busy === `role:${member.id}`}
                        onChange={(e) =>
                          void updateMemberRole(
                            member.id,
                            e.target.value as "ADMIN" | "MEMBER"
                          )
                        }
                        className="input !w-auto bg-surface py-1.5 text-xs font-semibold"
                      >
                        <option value="ADMIN">{t.settings.roleAdmin}</option>
                        <option value="MEMBER">{t.settings.roleMember}</option>
                      </select>
                    ) : (
                      roleBadge
                    )}
                    <button
                      type="button"
                      onClick={() => void removeMember(member.id)}
                      disabled={busy === `member:${member.id}`}
                      className="btn btn-sm btn-danger"
                    >
                      {busy === `member:${member.id}`
                        ? t.settings.removingMember
                        : t.settings.removeMember}
                    </button>
                  </div>
                ) : (
                  roleBadge
                )}
              </div>
            );
          })}
        </div>

        {membersData?.invitations.length ? (
          <div className="mt-6">
            <p className="mb-3 text-xs font-semibold text-muted">
              {t.settings.pendingInvites}
            </p>
            <div className="space-y-2">
              {membersData.invitations.map((invitation) => (
                <div
                  key={invitation.id}
                  className="inset flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">
                      {invitation.email}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {invitation.role === "ADMIN"
                        ? t.settings.roleAdmin
                        : t.settings.roleMember}
                      {invitation.inviteUrl && <> · {invitation.inviteUrl}</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {invitation.inviteUrl && (
                      <button
                        type="button"
                        onClick={() =>
                          void navigator.clipboard?.writeText(invitation.inviteUrl!)
                        }
                        className="btn btn-sm btn-ghost"
                      >
                        {t.common.copy}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => removeInvitation(invitation.id)}
                      disabled={busy === `invite:${invitation.id}`}
                      className="btn btn-sm btn-danger"
                    >
                      {t.settings.revoke}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {canManageMembers && (
          <form
            onSubmit={inviteMember}
            className="mt-6 grid gap-3 sm:grid-cols-[1fr_140px_auto]"
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder={t.settings.teammateEmailPlaceholder}
              className="input"
              required
            />
            <select
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as "ADMIN" | "MEMBER")
              }
              className="input"
            >
              <option value="MEMBER">{t.settings.roleMember}</option>
              <option value="ADMIN">{t.settings.roleAdmin}</option>
            </select>
            <button
              type="submit"
              disabled={busy === "invite"}
              className="btn btn-sm btn-primary"
            >
              {busy === "invite" ? t.settings.inviting : t.settings.invite}
            </button>
            {memberError && (
              <p className="text-sm text-error sm:col-span-3">{memberError}</p>
            )}
          </form>
        )}
      </Card>

      <Card title={t.settings.usage}>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">
                {t.settings.dmsSentThisMonth}
              </p>
              <p className="mt-0.5 text-xs text-muted">{t.settings.noPlanLimits}</p>
            </div>
            <span className="text-sm font-semibold text-white">
              {data?.workspace.dmsSentThisPeriod ?? 0}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-white">
                {t.assistant.usage.aiConversations}
              </p>
              <p className="mt-0.5 text-xs text-muted">{t.assistant.usage.aiConversationsHelp}</p>
            </div>
            <span className="text-sm font-semibold text-white">
              {data?.workspace.aiConversationsThisPeriod ?? 0} / {data?.workspace.aiConversationsLimit ?? "—"}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
