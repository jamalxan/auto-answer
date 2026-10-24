/** ETAP 13 Faza 2 — request bodies of the CSV import routes. */

import { z } from "zod";
import { CSV_MAX_CHARS, CSV_MAX_ROWS } from "./csv";

const csv = z.string().min(1, "Fayl bo'sh").max(CSV_MAX_CHARS, "Fayl juda katta (1 MB dan oshmasin)");

export const csvPreviewSchema = z.object({ csv });

export const csvCommitSchema = z.object({
  csv,
  rows: z.array(z.number().int().min(2)).min(1, "Import uchun birorta qator tanlanmagan").max(CSV_MAX_ROWS + 1),
});

export const csvScheduleSchema = z.object({
  postIds: z.array(z.string().min(1)).min(1).max(CSV_MAX_ROWS),
});
