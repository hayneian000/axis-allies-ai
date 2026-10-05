# Agent workflow: approvals, pushes, and repo conventions

How the AI assistant ("buddy") works with this repo, written down so the
approval overhead stays low and the conventions survive context switches.

## The approval situation

Every GitHub **write** (`create_branch`, file pushes, PR create/update)
requires Ian's approval on a card, every time. Reads never require approval.
This is enforced by the runtime above the agent — the agent cannot grant
itself standing permissions, waive approvals, or change any permission
setting. The agent also cannot see the approval card's layout or promise
which choice stops future prompts.

What the agent *can* do to minimize cards:

1. **Batch pushes.** Use `push_files` (multiple files, one commit, one
   approval) instead of `create_or_update_file` per file. A 12-file change
   costs 1 card, not 12. If a payload is too large for one call, split into
   2–3 batched pushes, not per-file pushes.
2. **Front-load all reads.** Do every `get_file_contents` / listing first;
   no approval needed, and it prevents write-then-fix churn.
3. **Stage everything locally first.** Build, test (`tsc`, full suite), and
   finalize before the first write, so approvals arrive in one burst while
   Ian is present instead of dribbling out over an hour.
4. **Typical card count per PR:** branch (1) + 1–2 batched pushes + PR open
   (1) = 3–4 cards total.

## What Ian can do on his side (agent cannot do this)

The Muse permissions settings page lists standing permissions and approval
defaults (per-connector approval behavior, per-site website defaults). If it
offers an "always allow"-style default for the GitHub connector, enabling it
would remove the per-call cards for repo writes. The agent cannot see or
change that page — it is Ian's lever, and the agent should never claim a
particular option exists there.

## Repo conventions

- **Branches:** feature branches off `main` (`<area>-<thing>`, e.g.
  `m3-diplomacy`); docs-only branches may use `docs/<thing>`. Ian merges
  PRs himself.
- **Never push `.github/*`.** The GitHub App lacks the Workflows permission
  (403); workflow edits are manual by Ian.
- **`engine/`, `data/` are the stable core.** Phase-2 agent work lives in
  `agents/` + `ui/` and must not redesign the engine; if agent work seems to
  need an engine change, that is a sign the abstraction leaked.
- **`docs/` is the system of record** (README, architecture, testing,
  ui-guide, phase2-agents, per-milestone specs). Keep the plan docs current
  in the same branch as the code they describe.
- **Tests:** `tsc` clean and the full suite green before any PR. Mock-first
  for provider tests; live-key testing is a documented gate, not a blocker.
- **Commit messages:** short imperative summaries; batched pushes may note
  `(1/2)`, `(2/2)` when split.
