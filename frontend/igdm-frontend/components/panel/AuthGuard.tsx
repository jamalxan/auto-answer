"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isAuthed } from "@/lib/api";

/** Panel sahifalari faqat token bo'lsa ochiladi; bo'lmasa /login ga qaytariladi. */
export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isAuthed()) {
      router.replace("/login");
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) return null;
  return <>{children}</>;
}
