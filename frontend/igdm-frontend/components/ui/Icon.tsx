import type { SVGProps } from "react";

const P: Record<string, string> = {
  panel: "M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v11h-7zM3 13h7v8H3z",
  jack: "M8 3v5M16 3v5M5 8h14v5a7 7 0 0 1-7 7 7 7 0 0 1-7-7z",
  funnel: "M3 4h18l-7 8v7l-4 2v-9z",
  log: "M4 5h16M4 10h16M4 15h10M4 20h7",
  lead: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4.6 14H4a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 5.7 8.5l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 11 4.6V4a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H23",
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  download: "M12 3v12M7 11l5 5 5-5M4 21h16",
  check: "M4 12l5 5L20 6",
  alert: "M12 3l9 16H3zM12 9v5M12 17h.01",
  chevron: "M9 6l6 6-6 6",
  bolt: "M13 2L4 14h6l-1 8 9-12h-6z",
  copy: "M9 9h11v11H9zM4 15V4h11",
  power: "M12 3v9M6.5 6.5a8 8 0 1 0 11 0",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  camera:
    "M4 4h16v16H4zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM17 7.5h.01",
  play: "M7 4l12 8-12 8z",
  arrow: "M5 12h14M13 5l7 7-7 7",
};

export default function Icon({
  name,
  size = 18,
  ...rest
}: { name: keyof typeof P | string; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={P[name] ?? P.panel} />
    </svg>
  );
}
