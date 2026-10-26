import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The Content Scheduler moved to the main dashboard; old links keep working.
export default async function ContentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  const query = params.toString();
  redirect(query ? `/content?${query}` : "/content");
}
