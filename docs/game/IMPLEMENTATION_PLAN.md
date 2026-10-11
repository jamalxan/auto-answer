# Implementation Plan: Vocabulary World

## Phase 0: Audit & Baseline (Completed)
- [x] Repository Audit conducted.
- [x] UI/UX Design System analysis completed.
- [x] Technology stack verified.

## Phase 1: Architecture Adaptation & Data Modeling
**Goal**: Prepare the database and typed contracts.
1. **Schema Migration**:
    - Create `Word` model (term, translation, definition, audioUrl, imageRef).
    - Create `UserWordProgress` model (userId, wordId, accuracy, lastReviewed, masteryLevel).
    - Create `GameSession` model (userId, mode, score, startedAt, completedAt).
    - Create `WorldProgress` model (userId, unlockedAreas, totalXp).
2. **Typed Contracts**:
    - Define `GamePrompt`, `GameSessionStatus`, and `GameModeDefinition` interfaces in `lib/game/types.ts`.
3. **Vocabulary Adapter**:
    - Implement `lib/game/vocabulary-adapter.ts` to transform DB words into game prompts.

## Phase 2: Foundation / Game Shell
**Goal**: Create the entry point and 3D loading boundary.
1. **Game Route**: Create `/vocabulary-world` page.
2. **Dynamic 3D Loader**:
    - Implement a `GameCanvas` component using `next/dynamic` to lazy-load Three.js.
    - Implement `LoadingScreen` and `WebGLFallback` components.
3. **HUD Skeleton**:
    - Build the DOM-based HUD using existing `.panel` and `Unbounded` font.
    - Implement basic navigation (Back to Dashboard, Settings).

## Phase 3: Shared Session Engine
**Goal**: Backend logic for starting and ending games.
1. **Server Actions**:
    - `startGameSession`: Initializes a session and returns initial prompts.
    - `submitAnswer`: Validates answers and updates temporary session state.
    - `finishGameSession`: Calculates final XP and persists progress.
2. **Scoring Logic**:
    - Implement deterministic XP calculation in `lib/game/scoring.ts`.

## Phase 4: World Map + Memory Game MVP
**Goal**: The first playable loop.
1. **3D World Map**:
    - Create a simple scene with one "Island" (Interaction Point).
    - Implement camera transition from World Map $\to$ Mini-game.
2. **Memory Game Implementation**:
    - Build the 3D "Card Flip" interaction using `@react-three/fiber`.
    - Connect the game loop to the `Shared Session Engine`.
3. **MVP Loop**:
    - User enters World $\to$ Clicks Island $\to$ Plays Memory Game $\to$ Receives XP $\to$ Progress saved.

## Phase 5: Expansion & Polish
- **Additional Games**: Word Runner $\to$ Word Lab $\to$ Boss Battle.
- **Progression**: Implement area unlocking logic.
- **Performance**: Texture compression (GLB) and frame rate optimization.
- **A11y**: ARIA labels for 3D interaction points.

## Verification Plan
- **Unit Tests**: Test `ScoringEngine` and `VocabularyAdapter` using `vitest`.
- **Integration Tests**: Verify that `finishGameSession` correctly updates `UserWordProgress` in PostgreSQL.
- **Smoke Test**: Play through the Memory Game on both Desktop and Mobile (iPhone/Android) to verify `h-dvh` and touch controls.
- **Regression**: Ensure the existing Instagram automation features remain unaffected.
