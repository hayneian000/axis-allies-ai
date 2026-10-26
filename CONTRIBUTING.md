# Contributing to axis-allies-ai

Thanks for your interest. Small, focused pull requests are the easiest to
review and merge.

## Getting started

Prerequisites: Node.js 18+ (20 LTS recommended) and npm 9+.

```bash
npm install
npm run dev      # start the dev server (usually http://localhost:5173)
npm test         # run the full test suite
```

## Code requirements

- `npx tsc --noEmit` must pass with zero errors.
- `npx vitest run` must pass (all tests green).
- New game rules must have rulebook citations in tests (`// 1942 2e p.XX`).
- Game logic lives in `engine/` (pure functions, no DOM). UI lives in `ui/`.

## Visual changes

CI does not run browser screenshots, so for any change that affects what
the game looks like, please include screenshots in your PR so reviewers can
see the result. Real captures of the running game only - please do not
present mockups or approximations as renders. If you cannot produce a real
browser capture in your environment, say so in the PR and describe the
manual verification steps you took instead.

This applies to:

- Map geometry changes (territory shapes, new polygons, label positions)
- UI changes (new screens, redesigned components, new animations)
- New visual features (intro sequences, effects, transitions)
- Style/theme changes (colors, fonts, layout)

To capture the game map, you can use the screenshot harness
(`npm run screenshots`, or `node scripts/screenshot.mjs <output.png>`), or
capture the UI directly in a browser. Attach the images to the PR
description and note what to look for; before/after pairs help for
redesigns.

## Branch and PR workflow

- Create feature branches from `main`. Do not commit directly to `main`.
- Open a PR with: summary of changes, test results, rule changes (if any),
  known deviations, and source citations.
- Do not merge without explicit approval from the maintainer.
- Changes under `.github/` (CI workflows) need maintainer review; mention
  them in the PR description.
