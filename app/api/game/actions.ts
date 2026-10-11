'use server';

import { prisma } from '@/lib/db';
import { calculateGameResult } from '@/lib/game/scoring';
import { GameSessionStatus } from '@/lib/game/types';
import { auth } from '@/auth';

export async function startGameSession(userId: string, mode: string, worldAreaId?: string) {
  const session = await auth();
  if (!session || session.user.id !== userId) {
    throw new Error('Unauthorized: User ID mismatch');
  }

  const gameSession = await prisma.gameSession.create({
    data: {
      userId,
      mode,
      worldAreaId,
      status: 'ready',
    },
  });
  return gameSession;
}

export async function finishGameSession(sessionId: string, correct: number, total: number, time: number, difficulty: any) {
  const authSession = await auth();
  if (!authSession) {
    throw new Error('Unauthorized');
  }

  const gameSession = await prisma.gameSession.findUnique({
    where: { id: sessionId },
  });

  if (!gameSession) throw new Error('Session not found');
  if (gameSession.userId !== authSession.user.id) {
    throw new Error('Unauthorized: This session does not belong to the authenticated user');
  }

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
    where: { userId: gameSession.userId },
    update: {
      totalXp: { increment: result.xpEarned },
    },
    create: {
      userId: gameSession.userId,
      totalXp: result.xpEarned,
      unlockedAreas: ['starting-island'],
    },
  });

  return { updatedSession, result };
}
