import nodemailer from "nodemailer";

// A plain "send one email" utility, independent of NextAuth's email
// *provider* abstraction (lib/auth.ts) — that one only fires from the
// sign-in flow. Same transport config (EMAIL_SERVER overrides Resend), so a
// deployment that already has magic links working needs no new setup for
// the admin password-reset email.

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail({ to, subject, text, html }: SendEmailInput): Promise<void> {
  const from = process.env.EMAIL_FROM ?? "SocialAuto <login@example.com>";
  const smtpServer = process.env.EMAIL_SERVER;

  if (smtpServer) {
    const transport = nodemailer.createTransport(smtpServer);
    await transport.sendMail({ to, from, subject, text, html });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("Neither EMAIL_SERVER nor RESEND_API_KEY is configured");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text, html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}
