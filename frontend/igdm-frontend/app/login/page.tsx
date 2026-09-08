"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field } from "@/components/ui/Kit";
import Icon from "@/components/ui/Icon";
import { useArrival } from "@/components/motion/useActs";
import { ApiError, login, setToken } from "@/lib/api";

export default function LoginPage() {
  const scope = useRef<HTMLDivElement>(null);
  useArrival(scope);
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { access_token } = await login(email, password);
      setToken(access_token);
      router.push("/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Server bilan bog'lanib bo'lmadi. Backend ishga tushganini tekshiring."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={scope} className="min-h-svh grid lg:grid-cols-2">
      {/* left: the panel fragment, same material as the landing hero */}
      <div className="relative grain hidden lg:flex flex-col justify-between p-10" style={{ background: "var(--c-field-deep)" }}>
        <Link href="/" className="util px-2 py-1 self-start" style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}>
          IGDM
        </Link>
        <div className="rig">
          <div data-arrival="plate" className="plate plate-specular rounded-bay p-6 max-w-[420px]">
            <p className="util text-paper/50 mb-3">kommutator holati</p>
            <div className="flex gap-3">
              {["kalit so'z", "shart", "havola"].map((l, i) => (
                <span key={l} className="flex-1 text-center">
                  <span
                    className="block w-8 h-8 mx-auto rounded-jack border-2"
                    style={{
                      borderColor: "var(--c-saffron)",
                      background: i === 0 ? "var(--c-signal)" : "transparent",
                    }}
                    aria-hidden
                  />
                  <span className="util block mt-2 text-paper/60">{l}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
        <p className="display text-d-2 max-w-[420px]">
          Izohdan direktgacha, siz uxlayotganingizda.
        </p>
      </div>

      {/* right: the form */}
      <div className="flex items-center justify-center p-6" style={{ background: "var(--c-field)" }}>
        <div className="w-full max-w-[380px]">
          <h1 className="display text-d-2" data-split>
            Panelga kirish
          </h1>
          <p className="mt-3 text-paper/75" data-arrival="sub">
            Admin hisobingiz bilan kiring. Instagram ulanishi keyingi qadamda.
          </p>

          <form className="mt-8 space-y-4" onSubmit={onSubmit}>
            <Field label="Pochta" htmlFor="email">
              <input
                id="email"
                type="email"
                className="input"
                autoComplete="email"
                placeholder="admin@everest.uz"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="Parol" htmlFor="pw" error={error}>
              <input
                id="pw"
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </Field>
            <button className="btn btn-primary w-full" type="submit" disabled={busy}>
              {busy ? "Tekshirilmoqda…" : "Kirish"}
              <Icon name="arrow" size={16} />
            </button>
          </form>

          <p className="util mt-6 text-paper/45">
            Hisobingiz yo&apos;qmi? <Link href="/register">Ro&apos;yxatdan o&apos;ting</Link>
          </p>
          <p className="util mt-2 text-paper/45">
            Parolni unutdingizmi? Egasiga murojaat qiling.
          </p>
        </div>
      </div>
    </div>
  );
}
