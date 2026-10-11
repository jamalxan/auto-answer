/**
 * Sound Manager for Vocabulary World.
 * Handles audio effects and background music for an immersive experience.
 */

class SoundManager {
  private static instance: SoundManager;
  private audioContext: AudioContext | null = null;

  private sounds: Record<string, string> = {
    correct: '/sounds/game/correct.mp3',
    wrong: '/sounds/game/wrong.mp3',
    click: '/sounds/game/click.mp3',
    levelUp: '/sounds/game/level-up.mp3',
    background: '/sounds/game/bg-music.mp3',
  };

  private bgMusic: HTMLAudioElement | null = null;

  private constructor() {}

  public static getInstance(): SoundManager {
    if (!SoundManager.instance) {
      SoundManager.instance = new SoundManager();
    }
    return SoundManager.instance;
  }

  private async initContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  public async playEffect(effect: keyof typeof this.sounds) {
    await this.initContext();
    const audio = new Audio(this.sounds[effect]);
    audio.volume = 0.5;
    audio.play().catch(e => console.warn('Audio playback failed', e));
  }

  public playBackgroundMusic() {
    if (this.bgMusic) return;
    this.bgMusic = new Audio(this.sounds.background);
    this.bgMusic.loop = true;
    this.bgMusic.volume = 0.3;
    this.bgMusic.play().catch(e => console.warn('BG music failed', e));
  }

  public stopBackgroundMusic() {
    if (this.bgMusic) {
      this.bgMusic.pause();
      this.bgMusic = null;
    }
  }
}

export const soundManager = SoundManager.getInstance();
