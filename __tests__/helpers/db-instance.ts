import { MemoryDb } from "./memory-db";

/** Shared in-memory database for tests that mock `@/lib/db/client`. */
export const db = new MemoryDb();

export function resetDb() {
  for (const key of Object.keys(db.tables)) db.tables[key] = [];
  db.log = [];
}
