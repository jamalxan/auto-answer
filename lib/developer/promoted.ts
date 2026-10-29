import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Old /developer link of a promoted module: sends to the main dashboard keeping ?tab= / ?flow= etc. */
export async function redirectPromoted(target: string, searchParams: SearchParams): Promise<never> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, v);
  }
  const query = params.toString();
  redirect(query ? `${target}?${query}` : target);
}
