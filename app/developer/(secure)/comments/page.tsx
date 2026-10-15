import CommentsDashboard from "@/components/developer/comments/comments-dashboard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Comment Automation 2.0 (dev)", robots: { index: false } };

// Guarded by the /developer (secure) layout.
export default function CommentAutomationPage() {
  return <CommentsDashboard />;
}
