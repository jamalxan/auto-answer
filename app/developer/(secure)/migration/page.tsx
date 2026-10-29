import { redirectPromoted } from "@/lib/developer/promoted";

// Promoted to the main dashboard.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await redirectPromoted("/migration", searchParams);
}
