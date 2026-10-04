# Contributing to axis-allies-ai

## Pull Request Requirements

### Visual Evidence (Required)

**Every PR that changes anything visual MUST include visual evidence.**

This includes:
- Map geometry changes (territory shapes, new polygons, label positions)
- UI changes (new screens, redesigned components, new animations)
- New visual features (intro sequences, effects, transitions)
- Style/theme changes (colors, fonts, layout)

**What counts as visual evidence:**
- Screenshots of the changed UI (before/after for redesigns)
- For animations/sequences: a composite showing key frames, or an animated GIF
- For map changes: a rendered map screenshot highlighting the changed area

**How to add it:**
1. Generate the screenshot using `node scripts/screenshot.mjs <output.png>` for the game map, or capture the UI directly.
2. Attach the image to the PR description or as a PR comment.
3. Describe what the image shows and what to look for.

**PRs without visual evidence will be asked to add it before merge.**

### Code Requirements

- `npx tsc --noEmit` must pass with zero errors.
- `npx vitest run` must pass (all tests green).
- New game rules must have rulebook citations in tests (`// 1942 2e p.XX`).
- Game logic lives in `engine/` (pure functions, no DOM). UI lives in `ui/`.

### Branch & PR Workflow

- Create feature branches from `main`. Do not commit directly to `main`.
- Open a PR with: summary of changes, test results, rule changes (if any), known deviations, and source citations.
- Do not merge without explicit approval.
- Note: The GitHub App cannot push `.github/*` — workflow file changes must be made manually.
