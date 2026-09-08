"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Field } from "@/components/ui/Kit";
import Icon from "@/components/ui/Icon";
import { useArrival } from "@/components/motion/useActs";
import { ApiError, registerVerify, requestRegisterOtp, setToken } from "@/lib/api";

export default function RegisterPage() {
  const scope = useRef<HTMLDivElement>(null);
  useArrival(scope);
  const router = useRouter();

  const [step, setStep] = useState<"email" | "verify">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendOtp() {
    setError("");
    setBusy(true);
    try {
      await requestRegisterOtp(email);
      setStep("verify");
      setCooldown(60);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Server bilan bog'lanib bo'lmadi.");
    } finally {
      setBusy(false);
    }
  }

  async function onRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    await sendOtp();
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Parollar mos emas");
      return;
    }
    setBusy(true);
    try {
      const { access_token } = await registerVerify(email, code, password);
      setToken(access_token);
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Server bilan bog'lanib bo'lmadi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={scope} className="min-h-svh grid lg:grid-cols-2">
      <div className="relative grain hidden lg:flex flex-col justify-between p-10" style={{ background: "var(--c-field-deep)" }}>
        <Link href="/" className="util px-2 py-1 self-start" style={{ background: "var(--c-paper)", color: "var(--c-field-deep)" }}>
          IGDM
        </Link>
        <p className="display text-d-2 max-w-[420px]">
          Yangi admin hisob — bir email, bitta tasdiqlash kodi.
        </p>
      </div>

      <div className="flex items-center justify-center p-6" style={{ background: "var(--c-field)" }}>
        <div className="w-full max-w-[380px]">
          <h1 className="display text-d-2" data-split>
            Ro&apos;yxatdan o&apos;tish
          </h1>
          <p className="mt-3 text-paper/75" data-arrival="sub">
            {step === "email"
              ? "Email manzilingizni kiriting, tasdiqlash kodi yuboramiz."
              : `${email} manziliga yuborilgan kodni kiriting.`}
          </p>

          {step === "email" ? (
            <form className="mt-8 space-y-4" onSubmit={onRequestOtp}>
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
              {error ? (
                <p className="text-[13px] flex items-start gap-1.5" style={{ color: "var(--c-madder)" }}>
                  <Icon name="alert" size={14} className="mt-0.5 shrink-0" />
                  {error}
                </p>
              ) : null}
              <button className="btn btn-primary w-full" type="submit" disabled={busy}>
                {busy ? "Yuborilmoqda…" : "Kod yuborish"}
                <Icon name="arrow" size={16} />
              </button>
            </form>
          ) : (
            <form className="mt-8 space-y-4" onSubmit={onVerify}>
              <Field label="Tasdiqlash kodi" htmlFor="code">
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  className="input"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  required
                />
              </Field>
              <Field label="Parol" htmlFor="pw" hint="Kamida 8 belgi">
                <input
                  id="pw"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
              </Field>
              <Field label="Parolni takrorlang" htmlFor="pw2" error={error}>
                <input
                  id="pw2"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={8}
                  required
                />
              </Field>
              <button className="btn btn-primary w-full" type="submit" disabled={busy}>
                {busy ? "Tekshirilmoqda…" : "Ro'yxatdan o'tish"}
                <Icon name="arrow" size={16} />
              </button>
              <button
                type="button"
                className="util w-full text-center text-paper/60 disabled:opacity-40"
                disabled={cooldown > 0 || busy}
                onClick={sendOtp}
              >
                {cooldown > 0 ? `Qayta yuborish (${cooldown}s)` : "Kodni qayta yuborish"}
              </button>
            </form>
          )}

          <p className="util mt-6 text-paper/45">
            Hisobingiz bormi? <Link href="/login">Kirish</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
