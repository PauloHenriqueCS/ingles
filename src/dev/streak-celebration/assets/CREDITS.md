# Streak-celebration PREVIEW assets — source & license

> These assets belong to the **isolated dev/preview lab** (`/dev/streak-celebration`).
> They are here only so we can audition the experience; nothing in the real
> product imports from this folder.

## Sounds

The preview's three sound options reuse existing project assets where possible;
only ONE new asset was added, and it comes from the same source/license family as
the ones already in `src/celebration/assets/sounds/` (**Mixkit Free License** —
free for commercial use, **no attribution required**, https://mixkit.co/license/#sfxFree).

| Preview option | File | Source |
|----------------|------|--------|
| Curta e discreta | *(reused)* `src/celebration/assets/sounds/activity-complete.mp3` | Mixkit SFX id 949 |
| Conquista mais forte | *(reused)* `src/celebration/assets/sounds/day-complete.mp3` | Mixkit SFX id 1938 |
| Premium / elegante | `premium-chime.mp3` (this folder) | Mixkit SFX id 2344 "Magic notification ring" |

- Source category: https://mixkit.co/free-sound-effects/
- To swap the premium option: drop a replacement `premium-chime.mp3` here.

No new audio **library** was added — playback reuses the existing
`HTMLAudioElement` pattern from `src/celebration/celebrationSound.ts`.

## Animations

No new animation assets were created. The **Trophy** variant reuses the existing
Lottie at `src/celebration/assets/lottie/day-complete.json`. The **Flame** and
**Orodim** variants are drawn with SVG + CSS and animated with the project's
existing **framer-motion** — no new library.
