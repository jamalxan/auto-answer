/**
 * Advanced Spaced Repetition System (SRS) based on the SM-2 algorithm.
 * Ensures that words are reviewed at optimal intervals to maximize long-term retention.
 */

export interface WordProgress {
  wordId: string;
  interval: number; // Days until next review
  repetition: number; // Number of consecutive correct answers
  efactor: number; // Easiness factor (default 2.5)
  nextReviewDate: Date;
}

export class SRSEngine {
  private static DEFAULT_EFACTOR = 2.5;
  private static MIN_EFACTOR = 1.3;

  /**
   * Calculates the new interval and ease factor based on the user's response.
   * @param quality Response quality (0-5): 0=complete blackout, 5=perfect recall
   */
  static calculateNextReview(progress: WordProgress, quality: number): WordProgress {
    let { interval, repetition, efactor } = progress;

    if (quality >= 3) {
      // Correct response
      if (repetition === 0) {
        interval = 1;
      } else if (repetition === 1) {
        interval = 6;
      } else {
        interval = Math.round(interval * efactor);
      }
      repetition += 1;
      efactor = efactor + (0.1 - (5 - quality) * (0.1 / 5));
    } else {
      // Incorrect response
      repetition = 0;
      interval = 1;
      efactor = Math.max(this.MIN_EFACTOR, efactor - 0.15);
    }

    const nextReviewDate = new Date();
    nextReviewDate.setDate(nextReviewDate.getDate() + interval);

    return {
      ...progress,
      interval,
      repetition,
      efactor: Math.max(this.MIN_EFACTOR, efactor),
      nextReviewDate,
    };
  }

  /**
   * Filters the vocabulary to find the most urgent words for review.
   */
  static getWordsDueForReview(allWords: WordProgress[]) {
    const now = new Date();
    return allWords
      .filter(wp => wp.nextReviewDate <= now)
      .sort((a, b) => a.nextReviewDate.getTime() - b.nextReviewDate.getTime());
  }
}
