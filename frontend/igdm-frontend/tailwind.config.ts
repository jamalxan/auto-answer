import type { Config } from "tailwindcss";

/**
 * Tokens live in app/globals.css as CSS variables.
 * Tailwind only *references* them — no raw hex anywhere in components.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        field: "var(--c-field)",
        "field-deep": "var(--c-field-deep)",
        "field-lift": "var(--c-field-lift)",
        madder: "var(--c-madder)",
        saffron: "var(--c-saffron)",
        signal: "var(--c-signal)",
        paper: "var(--c-paper)",
        "paper-2": "var(--c-paper-2)",
        ink: "var(--c-ink)",
        "ink-soft": "var(--c-ink-soft)",
        wrong: "var(--c-wrong)",
        line: "var(--c-line)",
      },
      fontFamily: {
        display: ["var(--f-display)"],
        body: ["var(--f-body)"],
        util: ["var(--f-util)"],
      },
      fontSize: {
        // scale ratio 1.333, base 17px
        "u-1": ["0.72rem", { lineHeight: "1.1", letterSpacing: "0.12em" }],
        "b-0": ["1.0625rem", { lineHeight: "1.55" }],
        "b-1": ["1.42rem", { lineHeight: "1.45" }],
        "d-1": ["1.89rem", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
        "d-2": ["2.52rem", { lineHeight: "1.0", letterSpacing: "-0.025em" }],
        "d-3": ["3.36rem", { lineHeight: "0.95", letterSpacing: "-0.03em" }],
      },
      borderRadius: { bay: "var(--r-bay)", jack: "999px" },
      maxWidth: { measure: "70ch" },
    },
  },
  plugins: [],
};
export default config;
