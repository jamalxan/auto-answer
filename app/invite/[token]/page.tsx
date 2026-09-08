import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import InvitationAcceptCard from "@/components/invitation-accept-card";
import LanguageSwitcher from "@/components/language-switcher";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

type InvitePageProps = {
  params: Promise<{ token: string }>;
};

export const metadata: Metadata = {
  title: "Accept Workspace Invitation",
  robots: { index: false, follow: false },
};

export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const [session, invitation, locale] = await Promise.all([
    auth(),
    prisma.workspaceInvitation.findUnique({
      where: { token },
      include: {
        workspace: { select: { name: true } },
      },
    }),
    getServerLocale(),
  ]);
  const t = dictionaries[locale];

  if (!invitation || invitation.status !== "PENDING") {
    notFound();
  }

  const expired = invitation.expiresAt <= new Date();

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center px-5 py-12">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/" className="font-display text-sm font-extrabold text-foreground">
            SocialAuto
          </Link>
          <LanguageSwitcher />
        </div>
        <section className="panel p-8">
          <p className="label-mono text-[11px] font-semibold text-accent">
            {t.invite.workspaceInvitation}
          </p>
          <h1 className="mt-4 font-display text-3xl font-extrabold leading-tight text-foreground">
            {t.invite.joinWorkspace(invitation.workspace.name)}
          </h1>
          <p className="mt-4 text-sm leading-6 text-muted">
            {t.invite.invitedAs(invitation.role.toLowerCase(), invitation.email)}
          </p>
          <div className="mt-8">
            {expired ? (
              <p className="text-sm text-error">{t.invite.expired}</p>
            ) : (
              <InvitationAcceptCard
                token={token}
                isSignedIn={Boolean(session?.user?.id)}
                invitedEmail={invitation.email}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

