# Docs

Everything beyond the [root README](../README.md). Start here if you're new to
the codebase.

## Index

| Doc | Read it when… |
|-----|----------------|
| [`architecture.md`](architecture.md) | You want the engine design, game state, or the action API (also the Phase 2 tool set) |
| [`testing.md`](testing.md) | You're writing or running tests — per-phase suites, the sim bot, what's covered where |
| [`browser-testing.md`](browser-testing.md) | You're touching the UI — the jsdom playthrough, the DOM contract it enforces, and the real-browser screenshot harness |
| [`ui-guide.md`](ui-guide.md) | You're restyling or adding UI — design tokens, DOM conventions, review workflow |
| [`phase2-agents.md`](phase2-agents.md) | You're working on the agent system — providers, prompts, driver, streaming, performance (implemented, not a sketch) |
| [`m3-diplomacy.md`](m3-diplomacy.md) | You're working on diplomacy — the freeform-talk spec, token budgets, JSON dump |
| [`board-space-map.md`](board-space-map.md) | You're touching the 1942 world map — TripleA board space (3500×2000), sources, rebuild, known gaps |
| [`rules-test-plan.md`](rules-test-plan.md) | You're writing rule tests — the rulebook-cited plan behind `tests/rules/` |
| [`style-guide.md`](style-guide.md) | You're doing visual work — the "war room, not board-game café" direction |
| [`muse-workflow.md`](muse-workflow.md) | You're an AI contributor — repo-specific operating notes (generic conventions live in root `AGENTS.md`) |
| [`history/`](history/) | You need superseded specs or old decisions |
| [`screenshots/`](screenshots/) | You want reviewed before/after contact sheets from past UI work |

## Adding a doc

- Guides live directly in `docs/`, named in kebab-case (`topic-name.md`).
- Superseded specs and old plans go in `docs/history/`, never deleted —
  history is cheap and "why did we do it this way" is expensive.
- Reviewed visual evidence goes in `docs/screenshots/`.
- Link new docs from this index and from the root README's Documentation
  section.
- Docs are written for a future contributor (or future-you) with no context.
  Say what, why, and where — not just how.
