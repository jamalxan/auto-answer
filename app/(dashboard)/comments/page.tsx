import CommentsDashboard from "@/components/developer/comments/comments-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Komment avtomatika", robots: { index: false } };

// Guarded by the dashboard layout (app session).
export default function CommentAutomationPage() {
  return <CommentsDashboard />;
}
