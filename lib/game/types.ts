/**
 * Enhanced types for the full Vocabulary World ecosystem.
 */

export type GameModeId = 'memory' | 'runner' | 'word-lab' | 'boss-battle';
export type GameDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'ielts';
export type GameSessionStatus = 'ready' | 'in_progress' | 'completed' | 'abandoned';

export interface GamePrompt {
  promptId: string;
  wordId: string;
  term: string;
  translation: string;
  definition?: string;
  audioUrl?: string;
  imageRef?: string;
  promptType: 'translation' | 'definition' | 'audio' | 'spelling' | 'sentence';
  question: any;
}

export interface GameSessionSummary {
  correct: number;
  wrong: number;
  timeSeconds: number;
  accuracy: number;
  xpEarned: number;
  grade: 'C' | 'B' | 'A' | 'S';
}

export interface WorldState {
  unlockedAreas: string[];
  totalXp: number;
  currentLevel: number;
  masteryCount: number;
}

export interface GameModeConfig {
  id: GameModeId;
  title: string;
  description: string;
  minLevel: number;
  xpMultiplier: number;
}

export const GAME_MODES: Record<GameModeId, GameModeConfig> = {
  memory: {
    id: 'memory',
    title: 'Memory Match',
    description: 'Find the pairs of words and translations.',
    minLevel: 1,
    xpMultiplier: 1
  },
  runner: {
    id: 'runner',
    title: 'Word Runner',
    description: 'Run and pick the correct meaning!',
    minLevel: 2,
    xpMultiplier: 1.2
  },
  'word-lab': {
    id: 'word-lab',
    title: 'Word Lab',
    description: 'Construct words from scattered letters.',
    minLevel: 3,
    xpMultiplier: 1.5
  },
  'boss-battle': {
    id: 'boss-battle',
    title: 'Boss Battle',
    description: 'The ultimate test of your knowledge.',
    minLevel: 5,
    xpMultiplier: 2.5
  },
};
