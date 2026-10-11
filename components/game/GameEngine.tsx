'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Float, Text, RoundedBox, PerspectiveCamera, OrbitControls, Sky, Stars } from '@react-three/drei';
import * as THREE from 'three';
import { soundManager } from '@/lib/game/sound-manager';

// --- Components ---

function Card({ position, value, isFlipped, onFlip, color }: any) {
  return (
    <Float speed={2} rotationIntensity={0.1} floatIntensity={0.1}>
      <mesh position={position} onClick={() => {
        soundManager.playEffect('click');
        onFlip();
      }}>
        <RoundedBox args={[1, 1, 0.1]} radius={0.1} smoothness={4}>
          <meshStandardMaterial color={isFlipped ? '#ffffff' : color} metalness={0.5} roughness={0.2} />
        </RoundedBox>
        {isFlipped && (
          <Text position={[0, 0, 0.06]} fontSize={0.3} color="#0a0b2e" anchorX="center" anchorY="middle">
            {value}
          </Text>
        )}
      </mesh>
    </Float>
  );
}

function RunnerPlayer({ position }: { position: THREE.Vector3 }) {
  return (
    <mesh position={position}>
      <sphereGeometry args={[0.4, 32, 32]} />
      <meshStandardMaterial color="#00f0b5" emissive="#00f0b5" emissiveIntensity={0.5} />
    </mesh>
  );
}

function WordGate({ position, value, isCorrect, onSelect }: any) {
  return (
    <group position={position}>
      <RoundedBox args={[2, 3, 0.2]} radius={0.1} smoothness={4}>
        <meshStandardMaterial color={isCorrect ? '#00f0b5' : '#11123c'} transparent opacity={0.8} />
      </RoundedBox>
      <Text position={[0, 0, 0.11]} fontSize={0.4} color="white" anchorX="center" anchorY="middle">
        {value}
      </Text>
    </group>
  );
}

function LabStation({ position, letters, onSelectLetter }: any) {
  return (
    <group position={position}>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[3, 3, 0.2, 32]} />
        <meshStandardMaterial color="#11123c" />
      </mesh>
      {letters.map((l: string, i: number) => (
        <Text
          key={i}
          position={[(i-2)*0.8, 0.2, 0]}
          fontSize={0.4}
          color="#00f0b5"
          onClick={() => {
            soundManager.playEffect('click');
            onSelectLetter(l);
          }}
        >
          {l}
        </Text>
      ))}
    </group>
  );
}

function BossModel({ health }: { health: number }) {
  return (
    <group position={[0, 2, -10]}>
      <mesh>
        <octahedronGeometry args={[2, 0]} />
        <meshStandardMaterial color="#ffb01f" emissive="#ffb01f" emissiveIntensity={0.5} />
      </mesh>
      <Text position={[0, 3, 0]} fontSize={0.5} color="white">
        BOSS HEALTH: {health}%
      </Text>
    </group>
  );
}

// --- Main Game Logic ---

export default function GameEngine({ prompts, onGameEnd, currentMode }: any) {
  const [gameState, setGameState] = useState<'intro' | 'playing' | 'result'>('intro');
  const [sessionData, setSessionData] = useState({ correct: 0, wrong: 0, time: 0 });
  const [memoryCards, setMemoryCards] = useState<any[]>([]);
  const [flipped, setFlipped] = useState<number[]>([]);
  const [matches, setMatches] = useState<number[]>([]);
  const [runnerPos, setRunnerPos] = useState(0);
  const [runnerX, setRunnerX] = useState(0);
  const [labWord, setLabWord] = useState('');
  const [labTarget, setLabTarget] = useState('');
  const [bossHealth, setBossHealth] = useState(100);

  useEffect(() => {
    if (currentMode === 'memory') {
      const cards: any[] = [];
      prompts.forEach((p: any, i: number) => {
        cards.push({ id: i * 2, value: p.term, isFlipped: false });
        cards.push({ id: i * 2 + 1, value: p.translation, isFlipped: false });
      });
      setMemoryCards(cards.sort(() => Math.random() - 0.5));
    } else if (currentMode === 'runner') {
      setLabTarget(prompts[0]?.translation || '');
    } else if (currentMode === 'word-lab') {
      setLabTarget(prompts[0]?.term || '');
    } else if (currentMode === 'boss-battle') {
      setBossHealth(100);
    }
  }, [currentMode, prompts]);

  useFrame((state) => {
    if (gameState === 'playing') {
      if (currentMode === 'runner') {
        setRunnerPos(prev => prev + 0.05);
        setRunnerX(prev => prev + 0); // Logic for joystick integrated in page.tsx
      }
    }
  });

  const handleMemoryFlip = (id: number) => {
    if (flipped.length === 2 || matches.includes(id)) return;
    const newCards = [...memoryCards];
    newCards[id].isFlipped = true;
    setMemoryCards(newCards);
    const newFlipped = [...flipped, id];
    setFlipped(newFlipped);

    if (newFlipped.length === 2) {
      const [f1, f2] = newFlipped;
      const isMatch = (memoryCards[f1].value === prompts[Math.floor(f1/2)]?.term && memoryCards[f2].value === prompts[Math.floor(f2/2)]?.translation) ||
                      (memoryCards[f1].value === prompts[Math.floor(f1/2)]?.translation && memoryCards[f2].value === prompts[Math.floor(f2/2)]?.term);

      setTimeout(() => {
        if (isMatch) {
          soundManager.playEffect('correct');
          setMatches([...matches, f1, f2]);
        } else {
          soundManager.playEffect('wrong');
          const reset = [...memoryCards];
          reset[f1].isFlipped = false;
          reset[f2].isFlipped = false;
          setMemoryCards(reset);
        }
        setFlipped([]);
      }, 800);
    }
  };

  const handleRunnerSelect = (val: string, isCorrect: boolean) => {
    if (isCorrect) {
      soundManager.playEffect('correct');
      setSessionData(prev => ({ ...prev, correct: prev.correct + 1 }));
    } else {
      soundManager.playEffect('wrong');
      setSessionData(prev => ({ ...prev, wrong: prev.wrong + 1 }));
    }
    setRunnerPos(0);
  };

  const handleLabSelect = (l: string) => {
    const nextWord = labWord + l;
    setLabWord(nextWord);
    if (nextWord === labTarget) {
      soundManager.playEffect('correct');
      setSessionData(prev => ({ ...prev, correct: prev.correct + 1 }));
      setLabWord('');
    } else if (nextWord.length >= labTarget.length) {
      soundManager.playEffect('wrong');
      setSessionData(prev => ({ ...prev, wrong: prev.wrong + 1 }));
      setLabWord('');
    }
  };

  const handleBossAttack = (isCorrect: boolean) => {
    if (isCorrect) {
      soundManager.playEffect('correct');
      setBossHealth(prev => Math.max(0, prev - 10));
      setSessionData(prev => ({ ...prev, correct: prev.correct + 1 }));
    } else {
      soundManager.playEffect('wrong');
      setSessionData(prev => ({ ...prev, wrong: prev.wrong + 1 }));
    }
  };

  useEffect(() => {
    if (currentMode === 'memory' && matches.length === memoryCards.length && memoryCards.length > 0) {
      onGameEnd({ correct: prompts.length, total: prompts.length, time: 0 });
    }
    if (currentMode === 'boss-battle' && bossHealth <= 0) {
      onGameEnd({ correct: 10, total: 10, time: 0 });
    }
  }, [matches, memoryCards, bossHealth, prompts]);

  return (
    <group>
      {gameState === 'intro' && (
        <Text
          position={[0, 2, 0]}
          fontSize={0.5}
          color="#00f0b5"
          onClick={() => {
            setGameState('playing');
            soundManager.playBackgroundMusic();
          }}
        >
          CLICK TO START {currentMode.toUpperCase()}
        </Text>
      )}

      {gameState === 'playing' && (
        <>
          {currentMode === 'memory' && (
            <group>
              {memoryCards.map((card: any, i: number) => (
                <Card
                  key={i}
                  position={[(i % 4) * 1.5 - 2.25, Math.floor(i / 4) * 1.5 - 1, 0]}
                  value={card.value}
                  isFlipped={card.isFlipped}
                  onFlip={() => handleMemoryFlip(i)}
                  color="#00f0b5"
                />
              ))}
            </group>
          )}

          {currentMode === 'runner' && (
            <group>
              <RunnerPlayer position={new THREE.Vector3(runnerX, 0, -runnerPos)} />
              <WordGate position={[2, 0, -20]} value="Apple" isCorrect={true} onSelect={() => handleRunnerSelect('Apple', true)} />
              <WordGate position={[-2, 0, -20]} value="Banana" isCorrect={false} onSelect={() => handleRunnerSelect('Banana', false)} />
            </group>
          )}

          {currentMode === 'word-lab' && (
            <LabStation
              position={[0, 0, 0]}
              letters={labTarget.split('')}
              onSelectLetter={handleLabSelect}
            />
          )}

          {currentMode === 'boss-battle' && (
            <group>
              <BossModel health={bossHealth} />
            </group>
          )}
        </>
      )}
    </group>
  );
}
