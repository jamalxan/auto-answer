import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Moved to the main dashboard; old links keep working.
export default function Moved() {
  redirect("/ads");
}
