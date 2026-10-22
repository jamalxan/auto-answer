"use client";

/**
 * Keyword Input
 *
 * Tag-style input for adding/removing keywords: a row of violet chips, each
 * with a remove button, above a pill input.
 */

import { useState, type KeyboardEvent } from "react";

interface KeywordInputProps {
  keywords: string[];
  onChange: (keywords: string[]) => void;
  max?: number;
}

export default function KeywordInput({ keywords, onChange, max = 10 }: KeywordInputProps) {
  const [input, setInput] = useState("");

  function addKeyword(value: string) {
    const trimmed = value.trim().toUpperCase();
    if (!trimmed) return;
    if (keywords.includes(trimmed)) return;
    if (keywords.length >= max) return;
    onChange([...keywords, trimmed]);
    setInput("");
  }

  function removeKeyword(keyword: string) {
    onChange(keywords.filter((k) => k !== keyword));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addKeyword(input);
    }
    if (e.key === "Backspace" && !input && keywords.length > 0) {
      removeKeyword(keywords[keywords.length - 1]);
    }
  }

  return (
    <div className="space-y-2">
      {keywords.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {keywords.map((keyword) => (
            <span
              key={keyword}
              className="inline-flex items-center gap-1.5 rounded-full bg-violet/25 px-3 py-1 text-sm text-white"
            >
              {keyword}
              <button
                type="button"
                onClick={() => removeKeyword(keyword)}
                aria-label={`Remove ${keyword}`}
                className="grid h-5 w-5 place-items-center rounded-full text-white/70 hover:bg-white/15 hover:text-white"
              >
                <span aria-hidden="true">×</span>
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={keywords.length === 0 ? "Type keyword and press Enter..." : ""}
        className="input"
      />
      <p className="text-xs text-muted">
        {keywords.length}/{max} keywords · Press Enter or comma to add
      </p>
    </div>
  );
}
