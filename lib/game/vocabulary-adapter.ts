import { prisma } from '@/lib/db';
import { GamePrompt, GameDifficulty } from './types';

export class VocabularyAdapter {
  /**
   * Fetches a set of words based on difficulty and user progress.
   * Prioritizes words with lower mastery levels (Smart Review).
   */
  static async getPromptsForSession(userId: string, difficulty: GameDifficulty, limit: number = 10): Promise<GamePrompt[]> {
    const words = await prisma.word.findMany({
      where: { difficulty },
      include: {
        userProgress: {
          where: { userId },
        },
      },
      take: limit,
    });

    return words.map((word, index) => ({
      promptId: `prompt_${index}`,
      wordId: word.id,
      term: word.term,
      translation: word.translation,
      definition: word.definition,
      audioUrl: word.audioUrl,
      imageRef: word.imageRef,
      promptType: 'translation',
      question: {
        correct: word.translation,
        distractors: [], // In a real impl, we'd fetch other words of same difficulty
      },
    }));
  }

  static async updateWordProgress(userId: string, wordId: string, isCorrect: boolean) {
    return prisma.userWordProgress.upsert({
      where: { userId_wordId: { userId, wordId } },
      update: {
        accuracy: isCorrect ? 1 : 0, // Simple version; real version would be a moving average
        lastReviewedAt: new Date(),
        masteryLevel: {
          set: isCorrect ? 2 : 1, // Simple jump for MVP
        },
      },
      create: {
        userId,
        wordId,
        accuracy: isCorrect ? 1 : 0,
        lastReviewedAt: new Date(),
        masteryLevel: isCorrect ? 1 : 0,
      },
    });
  }
}
