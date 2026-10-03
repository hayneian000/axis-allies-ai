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
| [`phase2-agents.md`](phase2-agents.md) | You're scoping Phase 2 — how LLM agents will drive turns (sketch, not spec) |
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
