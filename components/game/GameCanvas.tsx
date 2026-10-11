'use client';

import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Sky, Stars, PerspectiveCamera, Float, Text } from '@react-three/drei';

function Island() {
  return (
    <Float speed={2} rotationIntensity={0.5} floatIntensity={0.5}>
      <mesh position={[0, -1, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[3, 3.5, 1, 32]} />
        <meshStandardMaterial color="#11123c" roughness={0.3} metalness={0.8} />
      </mesh>
      <Text
        position={[0, 1, 0]}
        fontSize={0.5}
        color="#00f0b5"
        font="/fonts/unbounded.woff2" // Example path
      >
        Starting Island
      </Text>
    </Float>
  );
}

export default function GameCanvas() {
  return (
    <div className="h-full w-full bg-[#0a0b2e]">
      <Canvas shadows>
        <PerspectiveCamera makeDefault position={[0, 5, 10]} />
        <OrbitControls
          enablePan={false}
          maxPolarAngle={Math.PI / 2.1}
          minDistance={5}
          maxDistance={20}
        />

        <Sky sunPosition={[100, 10, 100]} />
        <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} intensity={1.5} castShadow />

        <Suspense fallback={null}>
          <Island />
        </Suspense>
      </Canvas>
    </div>
  );
}
