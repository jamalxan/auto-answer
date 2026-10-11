import React from 'react';
import dynamic from 'next/dynamic';
import { DashboardShell } from '@/components/dashboard-shell';

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
  return (
    <DashboardShell>
      <div className="relative h-[calc(100vh-64px)] w-full overflow-hidden bg-[#0a0b2e]">
        {/* 3D Canvas Layer */}
        <GameCanvas />

        {/* HUD Overlay Layer */}
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-6">
          <div className="flex justify-between items-start">
            <div className="panel p-4 backdrop-blur-xl border border-white/10 rounded-2xl">
              <h1 className="font-unbounded text-accent text-xl">Vocably World</h1>
              <p className="text-foreground/60 text-sm font-manrope">Explorer Level 1</p>
            </div>

            <div className="panel p-4 backdrop-blur-xl border border-white/10 rounded-2xl text-right">
              <p className="text-accent font-jetbrains-mono font-bold text-2xl">XP: 1,250</p>
            </div>
          </div>

          <div className="flex justify-center items-end gap-4 mb-8">
            <button className="pointer-events-auto panel px-6 py-3 bg-accent text-[#0a0b2e] font-unbounded rounded-full hover:bg-accent/80 transition-all transform hover:scale-105 shadow-[0_0_20px_rgba(0,240,181,0.4)]">
              Start Memory Game
            </button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
