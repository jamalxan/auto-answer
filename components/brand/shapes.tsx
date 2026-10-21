/**
 * The mark's three parts as large 3D objects for the "how it works"
 * chapters. Server-rendered CSS: a front face, a darker face 22px behind
 * it, and a slow perspective drift so the thickness reads.
 */

function Solid({
  shapeClass,
  front,
  back,
  className = "",
  children,
}: {
  shapeClass: string;
  front: string;
  back: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={`[perspective:1200px] ${className}`}>
      <div className="relative h-full w-full [transform-style:preserve-3d] motion-safe:animate-[drift-3d_12s_ease-in-out_infinite]">
        <span
          aria-hidden="true"
          className={`absolute inset-0 ${shapeClass}`}
          style={{ background: back, transform: "translateZ(-22px)" }}
        />
        <div
          className={`absolute inset-0 grid place-items-center ${shapeClass}`}
          style={{ background: front, transform: "translateZ(0)" }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** White comment bubble, as on the violet field. */
export function CommentSolid({ className = "" }: { className?: string }) {
  return (
    <Solid
      shapeClass="bubble-comment"
      front="#FFFFFF"
      back="#C9C2FF"
      className={`aspect-[6/5] w-full max-w-[22rem] ${className}`}
    />
  );
}

/** The trigger: a navy slab carrying the keyword in lime. */
export function TriggerSolid({
  keyword,
  className = "",
}: {
  keyword: string;
  className?: string;
}) {
  return (
    <Solid
      shapeClass="rounded-none"
      front="#0A0B2E"
      back="#05061A"
      className={`aspect-[3/2] w-full max-w-[22rem] ${className}`}
    >
      <span className="display px-6 text-center text-[clamp(2rem,6vw,3.5rem)] text-lime">
        {keyword}
      </span>
    </Solid>
  );
}

/** Violet DM bubble, as on the light field. */
export function DmSolid({ className = "" }: { className?: string }) {
  return (
    <Solid
      shapeClass="bubble-dm"
      front="#6C4BFF"
      back="#4A2FD0"
      className={`aspect-[6/5] w-full max-w-[22rem] ${className}`}
    />
  );
}
