# GAME_IMPLEMENTATION_ROADMAP.md

## Vocabulary World: Implementation Roadmap (Post-Audit Phase 4)

### Stage 1: Core Engine & Infrastructure (The Missing Link)
**Goal**: Build the authoritative server-side logic.
- **Task 1.1: Scoring Engine**: Create `lib/game/scoring.ts` to handle XP and accuracy calculations.
- **Task 1.2: Session Server Actions**: Implement `startGameSession`, `submitAnswer`, and `finishGameSession` in `app/api/game/actions.ts` (or similar).
- **Task 1.3: Backend Validation**: Ensure XP is awarded on the server, not the client.
- **Acceptance Criteria**: API returns a valid session and persists XP to the database.
- **Complexity**: Medium

### Stage 2: 3D Interaction & World Expansion
**Goal**: Make the 3D world interactive.
- **Task 2.1: Interaction System**: Add `onClick` handlers to the Island and other 3D objects to trigger game modes.
- **Task 2.2: Camera Transitions**: Implement smooth camera movements from "World View" to "Game View".
- **Task 2.3: World State Sync**: Connect the 3D map to `WorldProgress` model to show unlocked/locked areas.
- **Acceptance Criteria**: Clicking the island triggers a transition to the game mode.
- **Complexity**: Medium

### Stage 3: Memory Game Implementation (First MVP Game)
**Goal**: Deliver the first fully playable mini-game.
- **Task 3.1: Card Scene**: Build the 3D card grid and flip animations in `@react-three/fiber`.
- **Task 3.2: Game Loop**: Implement the matching logic (flip $\to$ check $\to$ result).
- **Task 3.3: Vocabulary Integration**: Use `VocabularyAdapter` to populate cards with real words.
- **Task 3.4: End-to-End Flow**: Start Game $\to$ Play $\to$ Submit Results $\to$ Receive XP.
- **Acceptance Criteria**: A user can complete a Memory Game and see their XP increase.
- **Complexity**: High

### Stage 4: Progression & Smart Review
**Goal**: Turn the game into a learning tool.
- **Task 4.1: Spaced Repetition Logic**: Implement the "Smart Review" filter in `VocabularyAdapter` to prioritize struggled words.
- **Task 4.2: Leveling System**: Implement XP thresholds for leveling up and unlocking new world areas.
- **Task 4.3: Achievement System**: Basic markers for milestones (e.g., "First 100 Words Mastered").
- **Acceptance Criteria**: Words that were answered incorrectly appear more frequently.
- **Complexity**: Medium

### Stage 5: Polish & Optimization
**Goal**: Performance and Accessibility.
- **Task 5.1: WebGL Fallback**: Create a simple 2D UI for users without WebGL support.
- **Task 5.2: Mobile Optimization**: Refine touch controls for the 3D camera and game interactions.
- **Task 5.3: Asset Compression**: Optimize GLB models and textures for faster loading.
- **Acceptance Criteria**: Stable 30+ FPS on mobile devices.
- **Complexity**: Medium

### Future Horizons
- **Word Runner**: Action-based vocabulary game.
- **Word Lab**: Spelling and construction challenges.
- **Boss Battle**: Comprehensive review of all learned vocabulary.
