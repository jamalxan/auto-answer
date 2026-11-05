import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin/auth";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { adminCopy } from "@/lib/admin/copy";
import AdminShell from "@/components/admin-shell";

export default async function AdminProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  const c = adminCopy(await getServerLocale());

  return (
    <AdminShell
      admin={{ username: session.username, email: session.email }}
      labels={{
        badge: c.badge,
        navOverview: c.navOverview,
        navCustomers: c.navCustomers,
        navPricing: c.navPricing,
        navSettings: c.navSettings,
        logout: c.logout,
        openMenu: c.openMenu,
        closeMenu: c.closeMenu,
        signedInAs: c.signedInAs,
      }}
    >
      {children}
    </AdminShell>
  );
}
