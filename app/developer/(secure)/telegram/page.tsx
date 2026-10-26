import TelegramDashboard from "@/components/developer/telegram/telegram-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Telegram kanal (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout.
export default function TelegramPage() {
  return <TelegramDashboard />;
}
