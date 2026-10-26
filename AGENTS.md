# AGENTS.md

Operating conventions for contributors and AI agents working in this repo
(`axis-allies-ai`: an Axis & Allies-style strategy game with a headless
TypeScript rules engine, SVG UI, and LLM-agent players).

## Repo conventions

- **Branches:** feature branches off `main` (`<area>-<thing>`, e.g.
  `m3-diplomacy`); docs-only branches may use `docs/<thing>`. The maintainer
  merges PRs.
- **Workflow changes need maintainer review.** Changes under `.github/`
  affect CI for everyone; call them out in the PR description.
- **`engine/` and `data/` are the stable core.** Agent/UI work lives in
  `agents/` + `ui/` and must not redesign the engine. If your work seems to
  need an engine change, the abstraction leaked - fix the abstraction, not
  the caller.
- **`docs/` is the system of record.** Keep plan docs current in the same
  branch as the code they describe.
- **Tests:** `tsc` clean and the full suite green before any PR. Mock-first
  for provider/LLM tests; live-key testing is a documented gate, never a
  blocker.
- **Batch your writes.** Stage everything locally, test it, then push in as
  few commits as possible. Never dribble one-file commits across a long
  session.
- **Commit messages:** short, imperative, one logical change per commit.

## Documentation

Start in `docs/` (README is the index): architecture, testing, ui-guide,
browser-testing, phase2-agents (+ per-milestone specs like `m3-diplomacy.md`),
and the canonical game rules in `engine/RULES.md`.
