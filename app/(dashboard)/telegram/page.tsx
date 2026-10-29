import TelegramDashboard from "@/components/developer/telegram/telegram-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Telegram kanal", robots: { index: false } };

// Guarded by the dashboard layout (app session).
export default function TelegramPage() {
  return <TelegramDashboard />;
}
