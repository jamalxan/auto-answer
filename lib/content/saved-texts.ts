/**
 * ETAP 13 — saved texts: hashtag groups, signatures, caption templates
 * (FR-C4). Workspace-scoped; other workspace's id → 404.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { notFound } from "./errors";

export const savedTextInputSchema = z.object({
  title: z.string().trim().min(1, "sarlavha kiritilmagan").max(32, "sarlavha 32 belgidan oshmasin"),
  body: z.string().min(1, "matn kiritilmagan").max(16_192, "matn 16 192 belgidan oshmasin"),
  tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
});
export type SavedTextInput = z.infer<typeof savedTextInputSchema>;

export async function listSavedTexts(workspaceId: string) {
  return prisma.savedText.findMany({ where: { workspaceId }, orderBy: { updatedAt: "desc" } });
}

export async function createSavedText(workspaceId: string, input: SavedTextInput) {
  return prisma.savedText.create({ data: { workspaceId, title: input.title, body: input.body, tags: input.tags } });
}

async function owned(workspaceId: string, id: string) {
  const row = await prisma.savedText.findUnique({ where: { id } });
  if (!row || row.workspaceId !== workspaceId) throw notFound("Shablon topilmadi");
  return row;
}

export async function updateSavedText(workspaceId: string, id: string, input: Partial<SavedTextInput>) {
  await owned(workspaceId, id);
  return prisma.savedText.update({ where: { id }, data: { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? { body: input.body } : {}), ...(input.tags !== undefined ? { tags: input.tags } : {}) } });
}

export async function deleteSavedText(workspaceId: string, id: string): Promise<void> {
  await owned(workspaceId, id);
  await prisma.savedText.delete({ where: { id } });
}
