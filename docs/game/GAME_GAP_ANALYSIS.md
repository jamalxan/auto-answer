# GAME_GAP_ANALYSIS.md

## Vocabulary World: Gap Analysis (Phase 4)

| Funksiya | Hozirgi holat | Kerakli natija | Yetishmayotgan ish | Ustuvorlik |
|---|---|---|---|---|
| **Session Management** | Mavjud emas | Server-side session lifecycle (start $\to$ submit $\to$ finish) | Server Actions va session state logikasini yozish | **Kritik** |
| **Scoring Engine** | Mavjud emas | Deterministik XP va ball hisoblash mantiqi | `lib/game/scoring.ts` modulini yaratish | **Kritik** |
| **Memory Game** | Faqat UI tugma | To'liq ishlaydigan 3D card-matching o'yini | Card flip logika, matching state va 3D scene yaratish | **Yuqori** |
| **3D Interaction** | Faqat vizual | Orol va obyektlar bilan o'zaro ta'sir (Click/Trigger) | `onClick` handlerlar va trigger tizimini qo'shish | **Yuqori** |
| **World Progression** | Model bor, logika yo'q | XP orqali yangi hududlarni ochish | Progression logic va WorldState API yaratish | **O'rta** |
| **WebGL Fallback** | Mavjud emas | WebGL ishlamagan taqdirda 2D variant ko'rsatish | Fallback UI komponentini yaratish | **Past** |
| **Resource Cleanup** | Avtomatik (Fiber) | Memory leak-larsiz Three.js resurslarini tozalash | Explicit `dispose` mantiqini qo'shish | **Past** |
