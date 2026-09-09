import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/auth";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import AdminShell from "@/components/admin-shell";

export default async function AdminProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  const locale = await getServerLocale();
  const t = dictionaries[locale].admin;

  return (
    <AdminShell
      labels={{
        navStats: t.navStats,
        navWorkspaces: t.navWorkspaces,
        navPricing: t.navPricing,
        navSettings: t.navSettings,
        navLogout: t.navLogout,
      }}
    >
      {children}
    </AdminShell>
  );
}
