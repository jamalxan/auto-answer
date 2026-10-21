"use client";

import { useEffect } from "react";
import { useLanguage } from "@/components/language-provider";
import { translateText, type PhraseTable } from "@/lib/i18n/dom-translate";
import type { UiLocale } from "@/lib/i18n/config";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "CODE", "PRE", "SVG", "OPTION"]);
const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
const SKIP_SELECTOR = "[data-no-translate], [contenteditable='true']";

// Originals are remembered per node so switching language is lossless and a
// node is never translated twice (cyrillic -> cyrillic, ru -> en).
const textOriginal = new WeakMap<Text, { src: string; out: string }>();
const attrOriginal = new WeakMap<Element, Map<string, { src: string; out: string }>>();

function skip(el: Element | null): boolean {
  return !el || SKIP_TAGS.has(el.tagName.toUpperCase()) || !!el.closest(SKIP_SELECTOR);
}

function applyText(node: Text, ui: UiLocale, table?: PhraseTable) {
  if (skip(node.parentElement)) return;
  const current = node.nodeValue ?? "";
  const known = textOriginal.get(node);
  // React rewrote the text (new value) -> that is the new source.
  const src = known && known.out === current ? known.src : current;
  const out = translateText(src, ui, table);
  textOriginal.set(node, { src, out });
  if (out !== current) node.nodeValue = out;
}

function applyAttrs(el: Element, ui: UiLocale, table?: PhraseTable) {
  if (skip(el)) return;
  let map = attrOriginal.get(el);
  for (const name of ATTRS) {
    const current = el.getAttribute(name);
    if (current === null) continue;
    if (!map) attrOriginal.set(el, (map = new Map()));
    const known = map.get(name);
    const src = known && known.out === current ? known.src : current;
    const out = translateText(src, ui, table);
    map.set(name, { src, out });
    if (out !== current) el.setAttribute(name, out);
  }
}

function walk(root: Node, ui: UiLocale, table?: PhraseTable) {
  if (root.nodeType === Node.TEXT_NODE) return applyText(root as Text, ui, table);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (skip(el)) return;
  applyAttrs(el, ui, table);
  const tree = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = tree.nextNode(); n; n = tree.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) applyText(n as Text, ui, table);
    else applyAttrs(n as Element, ui, table);
  }
}

async function loadTable(ui: UiLocale): Promise<PhraseTable | undefined> {
  if (ui === "ru") return (await import("@/lib/i18n/dev-phrases-ru")).phrasesRu;
  if (ui === "en") return (await import("@/lib/i18n/dev-phrases-en")).phrasesEn;
  return undefined;
}

/**
 * B-36: developer modules (and any other Uzbek-only screen) are written in
 * Uzbek Latin. For uz-Cyrl / ru / en this layer rewrites the rendered DOM:
 * transliteration for Cyrillic, a phrase table for ru/en. Unknown phrases stay
 * Uzbek. Opt out a subtree with `data-no-translate` (user content, code).
 */
export function DomTranslator() {
  const { uiLocale } = useLanguage();

  useEffect(() => {
    document.documentElement.lang = uiLocale;
    let observer: MutationObserver | undefined;
    let cancelled = false;

    void loadTable(uiLocale).then((table) => {
      if (cancelled) return;
      walk(document.body, uiLocale, table);
      if (uiLocale === "uz") return;

      const observe = () =>
        observer?.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: [...ATTRS],
        });
      observer = new MutationObserver((mutations) => {
        // Our own writes must not re-trigger us.
        observer?.disconnect();
        for (const m of mutations) {
          if (m.type === "characterData") walk(m.target, uiLocale, table);
          else if (m.type === "attributes") applyAttrs(m.target as Element, uiLocale, table);
          else m.addedNodes.forEach((n) => walk(n, uiLocale, table));
        }
        observe();
      });
      observe();
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [uiLocale]);

  return null;
}
