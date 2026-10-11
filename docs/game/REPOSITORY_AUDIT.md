# Repository Audit: Vocably.uz (SocialAuto)

## 1. Technology Stack
- **Framework**: Next.js 16.2.6 (App Router)
- **Language**: TypeScript 5
- **Package Manager**: npm
- **Database**: PostgreSQL via Prisma 7.8.0 (`prisma/schema.prisma`)
- **Authentication**: `next-auth` v5 beta (Database session strategy)
- **Background Processing**: `bullmq` + `ioredis` (used for Instagram API rate limiting)
- **Styling**: Tailwind CSS 4.0 with a custom internal design system in `app/globals.css`

## 2. Data Model Analysis
- **Current State**: The project is a B2B Instagram Automation SaaS. It lacks a dedicated vocabulary/word learning system.
- **Closet Existing Models**: 
    - `AssistantFaq` and `KnowledgeGap` (`prisma/schema.prisma`) store Q&A pairs. This can be evolved into the vocabulary base.
- **Gaps**: No `Word`, `UserWordProgress`, or `GameSession` models. These must be created.
- **Hierarchy**: Data is scoped to `Workspaces` (`prisma/schema.prisma`). This can be repurposed for "Study Groups" or "Classrooms."

## 3. API & Backend Patterns
- **Structure**: App Router API routes in `app/api/[domain]/route.ts`.
- **Logic Layer**: Heavy reliance on `lib/` for domain logic (e.g., `lib/assistant/`, `lib/meta/`).
- **Validation**: `zod` is used for schema validation.
- **Security**: 
    - Workspace-level isolation via `lib/workspace-access.ts`.
    - AES-GCM encryption for sensitive tokens.
    - Redis-based rate limiting (`lib/utils/rate-limiter.ts`).

## 4. UI/UX & Design System
- **Aesthetic**: Modern "Dark Mode" with Deep Indigo background (`#0a0b2e`) and Mint/Cyan accents (`#00f0b5`).
- **Typography**: 
    - Headings: `Unbounded` (Heavy)
    - Body: `Manrope`
    - Tech/Labels: `JetBrains Mono`
- **Visual Language**: 
    - Soft radii (`0.625rem`), `backdrop-blur-xl`, and hairline borders (`rgba(180, 182, 255, 0.11)`).
- **Responsiveness**: Uses `h-dvh` and `safe-area-inset` for mobile browser compatibility.

## 5. Test & CI/CD
- **Test Runner**: `vitest` (`package.json`).
- **Coverage**: Strong tests for LLM providers, rate limiters, and OAuth flows in `__tests__/`.
- **Deployment**: Vercel and Docker.

## 6. Reusable Assets for Game Integration
- **Auth/Session**: Reuse `next-auth` and workspace isolation logic.
- **Queueing**: Reuse `bullmq` for LLM-driven dynamic word generation to manage API costs/limits.
- **i18n**: Reuse the cookie-based locale system (`lib/i18n/config.ts`) for game localization.
- **UI Patterns**: Reuse `.panel` and `.label-mono` classes for the 3D HUD.
