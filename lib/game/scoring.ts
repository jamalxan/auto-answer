/**
 * Scoring Engine for Vocabulary World.
 * Handles deterministic XP and accuracy calculations.
 */

export interface ScoringInput {
  correctAnswers: number;
  totalQuestions: number;
  timeTakenSeconds: number;
  difficulty: 'beginner' | 'intermediate' | 'advanced' | 'ielts';
}

export interface ScoringResult {
  score: number;
  xpEarned: number;
  accuracy: number;
  grade: 'C' | 'B' | 'A' | 'S';
}

const DIFFICULTY_MULTIPLIER = {
  beginner: 1,
  intermediate: 1.5,
  advanced: 2,
  ielts: 3,
};

export function calculateGameResult(input: ScoringInput): ScoringResult {
  const { correctAnswers, totalQuestions, timeTakenSeconds, difficulty } = input;

  const accuracy = totalQuestions > 0 ? (correctAnswers / totalQuestions) : 0;

  // Base XP: correct answers * multiplier
  // Time Bonus: Bonus for finishing quickly (max 20% of base XP)
  const baseXP = correctAnswers * 10 * DIFFICULTY_MULTIPLIER[difficulty];
  const timeBonus = Math.max(0, 100 - timeTakenSeconds / 10) * 0.5;
  const totalXP = Math.floor(baseXP + timeBonus);

  // Grade calculation
  let grade: ScoringResult['grade'] = 'C';
  if (accuracy >= 0.95) grade = 'S';
  else if (accuracy >= 0.8) grade = 'A';
  else if (accuracy >= 0.6) grade = 'B';

  return {
    score: correctAnswers * 100,
    xpEarned: totalXP,
    accuracy,
    grade,
  };
}
