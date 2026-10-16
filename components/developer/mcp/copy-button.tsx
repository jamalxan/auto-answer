"use client";

import { useState } from "react";
import { secondaryButton } from "@/components/developer/ui";

/** Copies text to the clipboard and says "Nusxalandi" for two seconds. */
export default function CopyButton({ text, label = "Nusxalash" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setFailed(false);
      setTimeout(() => setDone(false), 2000);
    } catch {
      setFailed(true);
    }
  }

  return (
    <button type="button" className={secondaryButton} onClick={() => void copy()}>
      {done ? "Nusxalandi" : failed ? "Nusxalab bo'lmadi — qo'lda belgilang" : label}
    </button>
  );
}
