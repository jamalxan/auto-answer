import { redirect } from "next/navigation";

// Promoted to the main dashboard: keep old nested links working.
export default async function Page({ params }: { params: Promise<{ rest: string[] }> }) {
  const { rest } = await params;
  redirect(`/triggers/${rest.map(encodeURIComponent).join("/")}`);
}
