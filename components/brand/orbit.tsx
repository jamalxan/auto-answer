/**
 * The five networks in orbit around the mark: a CSS ring in real 3D
 * (preserve-3d, one tile every 72°), turning slowly; each tile counter-turns
 * so its logo always faces the visitor. Server-rendered, no script. The ring
 * is decoration — the accessible list of networks sits next to it.
 */

import type { CSSProperties } from "react";
import { BrandIcon, type BrandKey } from "@/components/brand-icons";
import LogoMark from "@/components/logo-mark";

export const ORBIT_NETWORKS: BrandKey[] = ["instagram", "facebook", "threads", "youtube", "telegram"];

export default function Orbit({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden="true" className={`orbit-scene relative mx-auto aspect-square w-full max-w-[30rem] ${className}`}>
      {/* The mark in the middle, slightly behind the front of the ring. */}
      <div className="orbit-core-wrap absolute inset-0 grid place-items-center">
        <div className="orbit-core grid h-[34%] w-[34%] place-items-center rounded-full bg-surface shadow-float">
          <LogoMark className="h-[58%] w-[58%]" />
        </div>
      </div>
      <div className="orbit absolute inset-0">
        {ORBIT_NETWORKS.map((network, i) => (
          <div key={network} className="orbit-item absolute left-1/2 top-1/2" style={{ "--i": i } as CSSProperties}>
            <div className="orbit-face grid h-[4.5rem] w-[4.5rem] place-items-center rounded-2xl bg-surface-hover shadow-float sm:h-[5.5rem] sm:w-[5.5rem]">
              <BrandIcon brand={network} className="h-9 w-9 sm:h-11 sm:w-11" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
