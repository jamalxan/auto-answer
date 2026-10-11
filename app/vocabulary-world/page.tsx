import React, { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { DashboardShell } from '@/components/dashboard-shell';
import { startGameSession, finishGameSession } from '@/app/api/game/actions';
import { VocabularyAdapter } from '@/lib/game/vocabulary-adapter';

// Lazy load the 3D Canvas to avoid bloating the initial bundle
const GameCanvas = dynamic(() => import('@/components/game/GameCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#0a0b2e] text-accent animate-pulse">
      <p className="font-unbounded text-2xl">Loading Vocabulary World...</p>
    </div>
  )
});

export default function VocabularyWorldPage() {
  const [gameMode, setGameMode] = useState<'world' | 'memory'>('world');
  const [prompts, setPrompts] = useState<any[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [score, setScore] = useState<any>(null);

  useEffect(() => {
    async function initGame() {
      // In a real app, we'd get userId from auth session
      const mockUserId = 'user_123';
      const session = await startGameSession(mockUserId, 'memory');
      setSessionId(session.id);

      const gamePrompts = await VocabularyAdapter.getPromptsForSession(mockUserId, 'beginner');
      setPrompts(gamePrompts);
    }
    initGame();
  }, []);

  async function handleGameEnd(results: any) {
    if (!sessionId) return;

    const finalResult = await finishGameSession(sessionId, results.correct, results.total, results.time, 'beginner');
    setScore(finalResult.result);
    setGameMode('world'); // Return to map
  }

  return (
    <DashboardShell>
      <div className="relative h-[calc(100vh-64px)] w-full overflow-hidden bg-[#0a0b2e]">
        {/* 3D Canvas Layer */}
        <GameCanvas
          gameMode={gameMode}
          setGameMode={setGameMode}
          prompts={prompts}
          onGameEnd={handleGameEnd}
        />

        {/* HUD Overlay Layer */}
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-6">
          <div className="flex justify-between items-start">
            <div className="panel p-4 backdrop-blur-xl border border-white/10 rounded-2xl">
              <h1 className="font-unbounded text-accent text-xl">Vocably World</h1>
              <p className="text-foreground/60 text-sm font-manrope">Explorer Level 1</p>
            </div>

            <div className="panel p-4 backdrop-blur-xl border border-white/10 rounded-2xl text-right">
              <p className="text-accent font-jetbrains-mono font-bold text-2xl">
                {score ? `XP +${score.xpEarned}` : 'XP: 1,250'}
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
              <button
                onClick={() => setGameMode('memory')}
                className="pointer-events-auto panel px-6 py-3 bg-accent text-[#0a0b2e] font-unbounded rounded-full hover:bg-accent/80 transition-all transform hover:scale-105 shadow-[0_0_20px_rgba(0,240,181,0.4)]"
              >
                Start Memory Game
              </button>
            )}
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
