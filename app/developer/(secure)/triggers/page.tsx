import { redirect } from "next/navigation";

// Promoted to the main dashboard.
export default function Page() {
  redirect("/triggers");
}
