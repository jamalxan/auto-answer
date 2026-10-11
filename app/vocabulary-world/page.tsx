import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { DashboardShell } from '@/components/dashboard-shell';
import { startGameSession, finishGameSession } from '@/app/api/game/actions';
import { VocabularyAdapter } from '@/lib/game/vocabulary-adapter';
import { GAME_MODES } from '@/lib/game/types';
import Joystick from '@/components/game/Joystick';

const GameCanvas = dynamic(() => import('@/components/game/GameCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#0a0b2e] text-accent animate-pulse">
      <p className="font-unbounded text-2xl">Loading Vocabulary World...</p>
    </div>
  )
});

export default function VocabularyWorldPage() {
  const [gameMode, setGameMode] = useState<'world' | keyof typeof GAME_MODES>('world');
  const [prompts, setPrompts] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [score, setScore] = useState<any>(null);
  const [userProgress, setUserProgress] = useState({ xp: 0, level: 1 });
  const [joystickState, setJoystickState] = useState({ x: 0, y: 0 });

  useEffect(() => {
    async function initUser() {
      const mockUserId = 'user_123';
      setUserProgress({ xp: 1250, level: 1 });
    }
    initUser();
  }, []);

  async function handleStartGame(mode: keyof typeof GAME_MODES) {
    const mockUserId = 'user_123';
    if (userProgress.level < GAME_MODES[mode].minLevel) {
      alert(`This mode requires level ${GAME_MODES[mode].minLevel}! Keep learning.`);
      return;
    }
    const session = await startGameSession(mockUserId, mode);
    setSessionId(session.id);
    const gamePrompts = await VocabularyAdapter.getPromptsForSession(mockUserId, 'beginner');
    setPrompts(gamePrompts);
    setGameMode(mode);
  }

  async function handleGameEnd(results: any) {
    if (!sessionId) return;
    const finalResult = await finishGameSession(sessionId, results.correct, results.total, results.time, 'beginner');
    setScore(finalResult.result);
    setGameMode('world');
  }

  return (
    <DashboardShell>
      <div className="relative h-[calc(100vh-64px)] w-full overflow-hidden bg-[#0a0b2e]">
        <GameCanvas
          gameMode={gameMode}
          setGameMode={setGameMode}
          prompts={prompts}
          onGameEnd={handleGameEnd}
          joystickInput={joystickState}
        />

        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-6">
          <div className="flex justify-between items-start">
            <div className="panel p-4 backdrop-blur-xl border border-white/10 rounded-2xl">
              <h1 className="font-unbounded text-accent text-xl">Vocably World</h1>
              <p className="text-foreground/60 text-sm font-manrope">Level {userProgress.level} Explorer</p>
            </div>
            <div className="panel p-4 backdrop-blur-xl border border-white/10 rounded-2xl text-right">
              <p className="text-accent font-jetbrains-mono font-bold text-2xl">
                {score ? `XP +${score.xpEarned}` : `XP: ${userProgress.xp}`}
              </p>
            </div>
          </div>

          {score && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-auto">
              <div className="panel p-8 backdrop-blur-2xl border border-accent/30 rounded-3xl text-center max-w-sm animate-in zoom-in duration-300">
                <h2 className="font-unbounded text-accent text-3xl mb-2">Game Over!</h2>
                <p className="text-foreground text-lg mb-4">You earned <span className="text-accent font-bold">{score.xpEarned} XP</span></p>
                <p className="text-foreground/60 font-manrope mb-6">Grade: <span className="text-gold font-bold">{score.grade}</span></p>
                <button
                  onClick={() => setScore(null)}
                  className="w-full py-3 bg-accent text-[#0a0b2e] font-unbounded rounded-xl hover:bg-accent/80 transition-all"
                >
                  Continue Exploring
                </button>
              </div>
            </div>
          )}

          <div className="flex justify-center items-end gap-4 mb-8">
            {gameMode === 'world' && (
              <div className="flex gap-3 pointer-events-auto">
                {Object.entries(GAME_MODES).map(([id, config]) => (
                  <button
                    key={id}
                    onClick={() => handleStartGame(id as any)}
                    className={`panel px-6 py-3 font-unbounded rounded-full transition-all transform hover:scale-105 border ${
                      userProgress.level >= config.minLevel
                        ? 'bg-accent text-[#0a0b2e] shadow-[0_0_20px_rgba(0,240,181,0.4)]'
                        : 'bg-white/5 text-white/30 border-white/10 cursor-not-allowed'
                    }`}
                  >
                    {config.title} {userProgress.level < config.minLevel && `(Lvl ${config.minLevel})`}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {gameMode !== 'world' && (
          <div className="absolute bottom-10 left-10 pointer-events-auto">
            <Joystick
              onMove={(x, y) => setJoystickState({ x, y })}
              onStop={() => setJoystickState({ x: 0, y: 0 })}
            />
          </div>
        )}
      </div>
    </DashboardShell>
  );
}
