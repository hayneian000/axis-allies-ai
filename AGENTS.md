# AGENTS.md

Operating conventions for AI agents working in this repo
(`axis-allies-ai`: an Axis & Allies-style strategy game with a headless
TypeScript rules engine, SVG UI, and LLM-agent players).

## If you are a Muse agent

Read `docs/muse-workflow.md` first. It covers the Muse-specific workflow:
approval-gated GitHub writes, batching pushes to minimize approval cards,
and the permissions picture (what the agent can and cannot do).

## Repo conventions (all agents)

- **Branches:** feature branches off `main` (`<area>-<thing>`, e.g.
  `m3-diplomacy`); docs-only branches may use `docs/<thing>`. Ian merges
  PRs himself.
- **Never push `.github/*`.** The GitHub App lacks the Workflows permission
  (403 on write); workflow edits are manual by Ian.
- **`engine/` and `data/` are the stable core.** Agent/UI work lives in
  `agents/` + `ui/` and must not redesign the engine. If your work seems to
  need an engine change, the abstraction leaked — fix the abstraction, not
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
