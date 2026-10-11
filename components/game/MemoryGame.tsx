'use client';

import React, { useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Float, Text, RoundedBox } from '@react-three/drei';
import * as THREE from 'three';

interface CardProps {
  position: [number, number, number];
  value: string;
  isFlipped: boolean;
  onFlip: () => void;
  color: string;
}

function Card({ position, value, isFlipped, onFlip, color }: CardProps) {
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    setRotation(isFlipped ? Math.PI : 0);
  }, [isFlipped]);

  return (
    <Float speed={1} rotationIntensity={0.2} floatIntensity={0.2}>
      <mesh position={position} onClick={onFlip} rotation={[0, rotation, 0]}>
        {/* Card Body */}
        <RoundedBox args={[1, 1, 0.1]} radius={0.1} smoothness={4}>
          <meshStandardMaterial
            color={isFlipped ? '#ffffff' : color}
            metalness={0.5}
            roughness={0.2}
          />
        </RoundedBox>

        {/* Text - Only visible when flipped */}
        {isFlipped && (
          <Text
            position={[0, 0, 0.06]}
            fontSize={0.3}
            color="#0a0b2e"
            anchorX="center"
            anchorY="middle"
          >
            {value}
          </Text>
        )}
      </mesh>
    </Float>
  );
}

export default function MemoryGame({
  prompts,
  onGameEnd
}: {
  prompts: any[],
  onGameEnd: (results: any) => void
}) {
  const [cards, setCards] = useState<{id: number, value: string, isFlipped: boolean}[]>([]);
  const [flippedCards, setFlippedCards] = useState<number[]>([]);
  const [matches, setMatches] = useState<number[]>([]);
  const [startTime] = useState(Date.now());

  useEffect(() => {
    // Create pairs of cards (term and translation)
    const gameCards: any[] = [];
    prompts.forEach((p, i) => {
      gameCards.push({ id: i * 2, value: p.term, isFlipped: false });
      gameCards.push({ id: i * 2 + 1, value: p.translation, isFlipped: false });
    });
    // Shuffle cards
    setCards(gameCards.sort(() => Math.random() - 0.5));
  }, [prompts]);

  const handleFlip = (id: number) => {
    if (flippedCards.length === 2 || matches.includes(id) || cards[id]?.isFlipped) return;

    const newCards = [...cards];
    newCards[id].isFlipped = true;
    setCards(newCards);

    const newFlipped = [...flippedCards, id];
    setFlippedCards(newFlipped);

    if (newFlipped.length === 2) {
      const [firstId, secondId] = newFlipped;
      const firstCard = cards[firstId];
      const secondCard = cards[secondId];

      // Check if it's a match (Simplified: we check if they belong to same prompt pair)
      // In a real app, we'd use the promptId. Here we check if one is term and other is translation
      const isMatch = (firstCard.value === prompts[Math.floor(firstId/2)]?.term && secondCard.value === prompts[Math.floor(secondId/2)]?.translation) ||
                      (firstCard.value === prompts[Math.floor(firstId/2)]?.translation && secondCard.value === prompts[Math.floor(firstId/2)]?.term);

      setTimeout(() => {
        if (isMatch) {
          setMatches([...matches, firstId, secondId]);
        } else {
          const resetCards = [...cards];
          resetCards[firstId].isFlipped = false;
          resetCards[secondId].isFlipped = false;
          setCards(resetCards);
        }
        setFlippedCards([]);
      }, 1000);
    }
  };

  useEffect(() => {
    if (cards.length > 0 && matches.length === cards.length) {
      const timeTaken = Math.floor((Date.now() - startTime) / 1000);
      onGameEnd({
        correct: prompts.length,
        total: prompts.length,
        time: timeTaken,
      });
    }
  }, [matches, cards, prompts]);

  return (
    <group position={[0, 0, 0]}>
      {cards.map((card, i) => {
        const x = (i % 4) * 1.5 - 2.25;
        const y = Math.floor(i / 4) * 1.5 - 1;
        return (
          <Card
            key={card.id}
            position={[x, y, 0]}
            value={card.value}
            isFlipped={card.isFlipped}
            onFlip={() => handleFlip(i)}
            color="#00f0b5"
          />
        );
      })}
    </group>
  );
}
