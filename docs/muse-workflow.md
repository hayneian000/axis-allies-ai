# Muse workflow: approvals, pushes, and permissions

Muse-specific operating notes for this repo. Generic repo conventions live
in `AGENTS.md` at the repo root; project documentation lives in `docs/`.

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
   costs 1 card, not 12. If a payload is too large for one call (argument
   limits), split into 2–3 batched pushes — never per-file pushes.
2. **Front-load all reads.** Do every `get_file_contents` / listing first;
   no approval needed, and it prevents write-then-fix churn.
3. **Stage everything locally first.** Build, test (`tsc`, full suite), and
   finalize before the first write, so approvals arrive in one burst while
   Ian is present instead of dribbling out over an hour. Never write
   scratch to `/tmp` and expect it to survive — it gets wiped.
4. **Typical card count per PR:** branch (1) + 1–2 batched pushes + PR open
   (1) = 3–4 cards total.

## What Ian can do on his side (agent cannot do this)

The Muse permissions settings page lists standing permissions and approval
defaults (per-connector approval behavior, per-site website defaults). If it
offers an "always allow"-style default for the GitHub connector, enabling it
would remove the per-call cards for repo writes. The agent cannot see or
change that page — it is Ian's lever, and the agent should never claim a
particular option exists there.

## Notes from experience

- Write calls are sometimes held for security review (minutes, not seconds);
  a second attempt after a genuine timeout is fine, but do not hammer.
- `push_files` cannot delete files; use `delete_file` for removals.
- Keep the plan docs (`docs/phase2-agents.md`, milestone specs) current in
  the same branch as the code they describe — the docs are the system of
  record, not chat history.
