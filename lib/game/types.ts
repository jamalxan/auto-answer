/**
 * Core types for the Vocabulary World game engine.
 * These types are shared between the client-side 3D engine and the server-side session management.
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
  question: any; // Implementation specific (e.g., choices for multiple choice)
}

export interface GameModeDefinition {
  id: GameModeId;
  titleKey: string;
  supportedInput: Array<'mouse' | 'keyboard' | 'touch'>;
}

export interface GameSessionSummary {
  correct: number;
  wrong: number;
  timeSeconds: number;
  accuracy: number;
  xpEarned: number;
}

export interface WorldState {
  unlockedAreas: string[];
  totalXp: number;
  currentLevel: number;
}
