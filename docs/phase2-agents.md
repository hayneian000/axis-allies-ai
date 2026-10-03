# Phase 2 agents — sketch

> **Status: roadmap, not spec.** This is the working sketch for replacing
> hot-seat players with LLM agents. Details will change when Phase 2 starts;
> the engine's action API (see [architecture](architecture.md)) is the stable
> part.

## The idea

The action API the UI drives — `purchase`, `combatMove`,
`resolveCombatRound`, `autoCasualties`, `nonCombatMove`, `mobilize`,
`sendMessage`, `summarizeState` — was designed to be the LLM tool set with no
translation layer. An agent's turn is the same sequence the UI walks a human
through; [architecture.md](architecture.md) ("How a Phase 2 agent drives one
turn") already spells out the call order.

## Building blocks that exist today

- **`summarizeState(pid)`** — <800-word board brief (owners, IPCs, units,
  banks, capitals, factories, turn/phase) designed to paste into prompts.
  Tested in `tests/economy.test.ts`.
- **`sendMessage` / `chatLog`** — negotiation channel. `{ sender,
  recipients, text, round }`, any phase, logged to events. The UI chat box is
  the manual version.
- **`autoCasualties(tid, side)`** — cheapest-first casualty policy so agents
  can skip `chooseCasualties` unless they want their own policy.
- **`tests/simulation.test.ts`** — the random-policy bot (`botTurn`,
  `botCombatMove`) is the starting point for an agent driver: it already
  sequences a full legal turn through the API.

## Open questions for Phase 2

1. **Turn driver.** A harness that maps agent → player, feeds
   `summarizeState` + chat history as prompts, validates tool calls against
   the action API, and advances phases. Probably a separate `agents/` package,
   not `engine/` changes.
2. **Negotiation protocol.** Free-text chat is there; do we need structured
   proposals (offer/accept/reject) or does free text plus a deal-extraction
   pass suffice? Undecided.
3. **Mixed games.** Hot-seat humans + agents in one game should work if the
   driver just treats "human" as a player it skips.
4. **Cost/latency tracking.** Every model call logged per game — needed before
   any tournament means anything.
5. **Tournament harness.** Brackets, Elo-style ratings, replay export. The sim
   bot's invariant assertions (`assertValidUnits`, event sequence) are the
   template for game-integrity checks.
6. **Determinism.** Engine RNG is seeded and replayable; agent decisions are
   not. Record prompts + responses per game so results are auditable even when
   not reproducible.

## Non-goals

No engine redesign. If Phase 2 needs an engine change, that's a sign the
abstraction leaked — fix the abstraction, not the caller.
