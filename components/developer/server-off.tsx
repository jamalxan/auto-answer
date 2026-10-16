"use client";

import { createContext, useContext, type ReactNode } from "react";
import { Notice } from "@/components/developer/comments/parts";

/**
 * Whether the signed-in user is a platform admin (ADMIN_EMAILS). Server env
 * names such as CRM_ENABLED are operator vocabulary: developer users get a
 * plain sentence, platform admins additionally get a collapsed "Admin/ops" note.
 */
const PlatformAdminContext = createContext(false);
export const PlatformAdminProvider = PlatformAdminContext.Provider;
export const usePlatformAdmin = () => useContext(PlatformAdminContext);

/** "<what stopped>. Bu modul serverda o'chirilgan — administrator yoqadi." + admin-only ops details. */
export function ServerOffNotice({
  what,
  ops,
  tone = "error",
  moduleOff = true,
}: {
  /** Plain Uzbek: what does not work while the module is off. */
  what: ReactNode;
  /** Admin/ops detail (env names, restart steps). Only rendered for platform admins. */
  ops: ReactNode;
  tone?: "info" | "warning" | "error";
  moduleOff?: boolean;
}) {
  const isAdmin = usePlatformAdmin();
  return (
    <Notice tone={tone}>
      {what}
      {moduleOff && <> Bu modul serverda o&apos;chirilgan — administrator yoqadi.</>}
      {isAdmin && (
        <details className="mt-1.5 text-muted">
          <summary className="cursor-pointer text-xs font-semibold">Admin/ops</summary>
          <p className="mt-1">{ops}</p>
        </details>
      )}
    </Notice>
  );
}
