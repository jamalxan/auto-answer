'use server';

import { prisma } from '@/lib/db';
import { calculateGameResult } from '@/lib/game/scoring';
import { GameSessionStatus } from '@/lib/game/types';

export async function startGameSession(userId: string, mode: string, worldAreaId?: string) {
  const session = await prisma.gameSession.create({
    data: {
      userId,
      mode,
      worldAreaId,
      status: 'ready',
    },
  });
  return session;
}

export async function finishGameSession(sessionId: string, correct: number, total: number, time: number, difficulty: any) {
  const session = await prisma.gameSession.findUnique({
    where: { id: sessionId },
  });

  if (!session) throw new Error('Session not found');

  const result = calculateGameResult({
    correctAnswers: correct,
    totalQuestions: total,
    timeTakenSeconds: time,
    difficulty,
  });

  const updatedSession = await prisma.gameSession.update({
    where: { id: sessionId },
    data: {
      score: result.score,
      xpEarned: result.xpEarned,
      status: 'completed',
      completedAt: new Date(),
      summary: {
        accuracy: result.accuracy,
        grade: result.grade,
        time: time,
      },
    },
  });

  // Update User World Progress
  await prisma.worldProgress.upsert({
    where: { userId: session.userId },
    update: {
      totalXp: { increment: result.xpEarned },
    },
    create: {
      userId: session.userId,
      totalXp: result.xpEarned,
      unlockedAreas: ['starting-island'],
    },
  });

  return { updatedSession, result };
}
