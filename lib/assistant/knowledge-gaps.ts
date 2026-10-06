import { prisma } from "@/lib/db/client";
import { similarity } from "./humanize";

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const MERGE_THRESHOLD = 0.7;

/**
 * Record a question the assistant could not answer (TZ 3A.7). Similar
 * questions are merged by plain text similarity and counted, so the owner gets
 * "Samarqandga yetkazib berasizmi? (4 marta)" instead of four lines.
 */
export async function recordKnowledgeGap(workspaceId: string, question: string): Promise<void> {
  const normalized = normalizeQuestion(question);
  if (normalized.length < 4) return;

  const open = await prisma.knowledgeGap.findMany({
    where: { workspaceId, status: { in: ["OPEN", "IGNORED"] } },
    select: { id: true, questionNormalized: true, examples: true, status: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  const match = open.find((g) => similarity(g.questionNormalized, normalized) >= MERGE_THRESHOLD);

  if (match) {
    if (match.status === "IGNORED") return; // the owner already waved this one away
    const examples = Array.isArray(match.examples) ? (match.examples as string[]) : [];
    await prisma.knowledgeGap.update({
      where: { id: match.id },
      data: {
        hits: { increment: 1 },
        examples: [...examples, question.slice(0, 200)].slice(-5),
      },
    });
    return;
  }

  await prisma.knowledgeGap.create({
    data: { workspaceId, questionNormalized: normalized, examples: [question.slice(0, 200)] },
  });
}
