# SocialAuto — Design System

Source of truth: **SocialAuto Brend kitobi v1.0 (oktabr 2026)** and the logo kit.
Tokens live in `app/globals.css` (`@theme`); every page styles itself from them.

## Idea

The logo is the product: a comment bubble arrives, the overlap (the trigger)
fires, a DM bubble leaves. On the landing page that mechanism *is* the hero
(`components/brand/hero-demo.tsx`): a real comment, the keyword match, the
DM that follows, standing in a perspective scene that tilts toward the cursor.
The three "how it works" chapters wear the mark's three colours.

## Colour (60 · 30 · 10)

| Role | Token | Hex | Use |
|---|---|---|---|
| Midnight | `midnight` / `background` | `#0A0B2E` | ground, 60% |
| Electric Violet | `violet` / `primary` | `#6C4BFF` | primary buttons, DM bubble, full-bleed chapters, "Auto" on light |
| Signal Lime | `lime` / `accent` / `success` | `#D4FF3A` | trigger, emphasis, "Auto" on dark, lime CTA on violet. Never as text on light |
| Cloud | `cloud` | `#F4F4FA` | light chapters, light input fill |
| Slate | `slate` | `#5B5E7A` | secondary text on light |
| Surface | `surface` / `surface-hover` | `#13143D` / `#1C1D4D` | one tone step up from Midnight; cards, sidebar |
| Muted | `muted` | `#A7AACB` | secondary text on dark |
| Warning / Error | `warning` / `error` | `#FFB01F` / `#FF5D4D` | status only |

Rules: flat fields, no gradients, no hairlines (surfaces separate by tone
step), shadows only under things that float (the 3D bubbles, the app window).
Secondary text on a coloured field is a tint of the foreground
(`text-white/85`, `text-midnight/80`), never grey.

## Type

- **Unbounded 600** (`.display`, `font-display`): headlines, numbers, the
  wordmark. Tracking −0.03em, line-height 1. Scale: hero 2.15→4.75rem,
  section 2→3.4rem, chapter 1.7→2.4rem, card 1.25–1.5rem.
- **Inter** (`font-sans`): everything else. Body 17–20px, line-height 1.6,
  measure ≤ 65ch. Buttons 16/600.
- No eyebrows, no uppercase tracked labels, no monospace outside code.
  `.label-mono` is kept for legacy call sites and now renders as Inter 600.

## Shape

- Pills everywhere: buttons (`.btn`), inputs, chips, nav items.
- The mark's bubble geometry as CSS: `.bubble-comment` (sharp bottom-right)
  and `.bubble-dm` (sharp top-left).
- Cards `rounded-3xl`, tiles `rounded-2xl`.

## Logo

`components/logo-mark.tsx`: `LogoMark` (SVG mark, tones `dark` / `light` /
`violet` per the brand book) and `Wordmark` (mark + "Social**Auto**",
"Auto" always in the accent colour). Kit files in `public/brand/`, favicons
and OG image in `public/`. Clear space: one bubble height. Minimum: mark
20px, lockup 110px.

## Motion

- Signature: the mark assembling itself (`bubble-in-top`, `trigger-pop`,
  `bubble-in-bottom`), then a slow `drift-3d` in perspective
  (`components/brand/mark-scene.tsx`, the hero demo, chapter solids).
- Scroll reveals (`components/brand/reveal.tsx`): rise 28px + fade, staggered
  60–160ms, visible by default without script.
- Pointer tilt (`components/brand/tilt.tsx`): ±6° on the app window, with a
  CSS scroll-timeline "unfold" where supported.
- Everything respects `prefers-reduced-motion`.

## Surfaces

- **Landing** (`app/page.tsx`): poster headline → live demo → three coloured
  chapters → tilted dashboard → trust band → features list → pricing on
  Cloud → FAQ → Violet close → footer with the name at full width.
- **Login** (`app/login/page.tsx`): Violet brand field with the mark scene,
  Midnight form side.
- **App shell** (`components/sidebar.tsx`, `top-bar.tsx`,
  `dashboard-shell.tsx`): solid surfaces, violet active pill, lime status dot.
