# Game Architecture: Vocabulary World

## 1. High-Level Design
The "Vocabulary World" is a 3D extension of the Vocably platform. It separates the **Visual Rendering (3D Engine)** from the **Game Logic (Vocabulary Engine)** and the **Persistence Layer (Database)**.

### Layered Responsibility
| Layer | Responsibility | Tech Stack |
| :--- | :--- | :--- |
| **Presentation (UI)** | HUD, Menus, Loading/Error states, Responsive Overlays | React, Tailwind CSS 4 |
| **3D Rendering** | World Map, Mini-game Scenes, Camera, Assets, Input | Three.js, `@react-three/fiber`, `@react-three/drei` |
| **Game Application** | Session Lifecycle, Answer Submission, Progression Logic | TypeScript, Next.js Server Actions |
| **Domain (Rules)** | Scoring, XP Calculation, Mastery Levels, Unlock Rules | Pure TypeScript |
| **Data Access** | Vocabulary fetching, Progress saving, Session tracking | Prisma, PostgreSQL |
| **Platform Integration**| Auth, User Profile, Locale, Workspace Isolation | `next-auth`, `lib/i18n` |

## 2. Core Modules

### 2.1 Vocabulary Engine (The "Brain")
Acts as an adapter between the database and the game modes.
- **VocabularyAdapter**: Normalizes `Word` models into a `GamePrompt` format (Word $\to$ Translation/Image/Audio).
- **SessionManager**: Handles the state of a game session (Started $\to$ In-Progress $\to$ Completed).
- **ScoringEngine**: Deterministic calculation of XP and accuracy based on response time and attempts.

### 2.2 3D World Engine (The "Body")
- **WorldCanvas**: The root Three.js scene.
- **SceneRegistry**: Dynamically loads the requested mini-game scene (e.g., `MemoryGameScene`, `RunnerScene`).
- **HUD Layer**: DOM-based overlay that uses the existing Vocably design system (Deep Indigo / Mint).

### 2.3 Progression System
- **Mastery Model**: Tracks per-word accuracy and confidence.
- **World Progression**: A graph of "Islands" or "Areas" that unlock as total XP increases.
- **Review Loop**: Integrates with a spaced-repetition scheduler to re-insert "failed" words into future sessions.

## 3. Data Flow
1. **Request**: User enters `/vocabulary-world`.
2. **Init**: Server Action fetches user's `WorldState` (Unlocked areas, total XP).
3. **Session**: User starts a game $\to$ `SessionManager` creates a record $\to$ `VocabularyAdapter` fetches a set of words.
4. **Gameplay**: 3D Engine renders prompts $\to$ User answers $\to$ Client sends result to Server Action.
5. **Sync**: `ScoringEngine` updates `UserWordProgress` $\to$ Session closes $\to$ XP is awarded to the User.

## 4. Technical Constraints
- **Bundle Optimization**: Three.js and `@react-three/fiber` must be **dynamic imports** to avoid slowing down the main dashboard.
- **Authoritative State**: XP and Mastery are calculated and saved on the server; the client only receives the result.
- **WebGL Fallback**: If WebGL is unavailable, a 2D "Game List" view is provided.
