'use client';

import React, { useState, useRef, useEffect } from 'react';

interface JoystickProps {
  onMove: (x: number, y: number) => void;
  onStop: () => void;
}

export default function Joystick({ onMove, onStop }: JoystickProps) {
  const joystickRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  const handleStart = (e: React.PointerEvent | React.MouseEvent) => {
    setIsDragging(true);
    handleRef.current!.style.transition = 'none';
  };

  const handleMove = (e: React.PointerEvent | React.MouseEvent) => {
    if (!isDragging) return;

    const rect = joystickRef.current?.getBoundingClientRect();
    if (!rect) return;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let dx = e.clientX - centerX;
    let dy = e.clientY - centerY;

    const distance = Math.sqrt(dx * dx + dy * dy);
    const maxRadius = rect.width / 2;

    if (distance > maxRadius) {
      dx *= maxRadius / distance;
      dy *= maxRadius / distance;
    }

    setPosition({ x: dx, y: dy });
    if (handleRef.current) {
      handleRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
    }

    // Normalize to -1 to 1 for the game engine
    onMove(dx / maxRadius, dy / maxRadius);
  };

  const handleEnd = () => {
    setIsDragging(false);
    if (handleRef.current) {
      handleRef.current.style.transition = 'transform 0.2s ease-out';
      handleRef.current.style.transform = 'translate(0, 0)';
    }
    setPosition({ x: 0, y: 0 });
    onStop();
  };

  return (
    <div
      ref={joystickRef}
      className="w-32 h-32 bg-white/10 backdrop-blur-md rounded-full border-2 border-white/20 relative touch-none"
      onPointerDown={handleStart}
      onPointerMove={handleMove}
      onPointerUp={handleEnd}
      onPointerLeave={handleEnd}
    >
      <div
        ref={handleRef}
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-12 h-12 bg-accent rounded-full shadow-[0_0_15px_rgba(0,240,181,0.6)] cursor-pointer"
      />
    </div>
  );
}
