# M3 — Diplomacy spec: freeform talk + JSON dump

> **Status: spec.** This is the build spec for M3 diplomacy. It covers the
> talk system and the end-of-game JSON dump only. Everything analytical —
> commitment extraction, betrayal detection, alliance graphs, the reputation
> ledger — is explicitly deferred until the dump exists to parse.

## Goal

Let LLM seats talk to each other freely — publicly and privately — so the
adversarial social dynamics (disclosure, persuasion, alliance-making,
betrayal) can actually happen and be recorded. The game enforces nothing
about *what* is said; it only bounds *how much* can be said (token budgets)
and records everything for later analysis.

## Non-goals (deferred, not dropped)

- Commitment extraction ("was that a promise?"), betrayal detection,
  alliance graphs, per-player reputation ledgers.
- Structured or engine-enforced deals (pacts, treaties). Talk is cheap and
  non-binding by design in this phase.
- Agent-initiated chat outside the diplomacy window (see below).

## Transport (already in the engine)

`sendMessage(state, senderId, recipients, text)` — no engine changes needed:

- `recipients`: `"all"` for broadcast, or player names (`"Player 2"`,
  comma-separated for groups). Empty/invalid recipients are rejected.
- `text`: non-empty, max 500 chars (`MAX_CHAT_LENGTH`).
- Works in any phase; entries land in `state.chatLog` as
  `{ sender, recipients, text, round }` and in the event log (`'chat'`).
- Delivery filtering is the existing `visibleChat` rule: a seat sees a
  message iff recipients is `"all"` or includes its player name. The driver
  must never leak other seats' private mail into prompts — the per-seat
  isolation invariant from M1 applies unchanged.

## The diplomacy window

One window per round, at the **start of the round** before the first player's
purchase phase. Round-robin in turn order; on its turn a seat may send any
number of messages (subject to budget) and then signals it is done.

The window closes when any of these is true:

1. Every seat has signaled done, or
2. Every seat's budget is exhausted, or
3. A backstop iteration cap is hit (e.g. 12 turns per seat — an anti-runaway
   fuse, not a gameplay rule).

No rules about message counts, exchange counts, or who may talk to whom.
The only constraints are economic (budget) and voluntary (done signal).

## Token budget (the anti-death-spiral mechanism)

- Each AI seat gets a diplomacy token budget per round (constant, e.g. 2500
  tokens; tunable, recorded in the dump). Spend = actual input+output tokens
  of that seat's diplomacy calls. No rollover to the next round.
- A seat with an exhausted budget is silent for the rest of the window —
  its chat tools are simply withheld.
- The agent's window prompt states its remaining budget and that it may stop
  at any time. Long threads are distilled to summaries so spamming has
  diminishing returns (distillation is an implementation detail, not a rule).

## Agent tools in the window

Exactly two, exposed only during the window:

- `send_message { recipients: string, text: string }` — validated through
  `sendMessage`; rejections (bad recipients, over length) are reported back
  like any tool error and count against the retry path, not the budget
  (only successful provider round-trips spend budget).
- `end_diplomacy {}` — voluntary exit. Consumed by the driver, not dispatched.

The window prompt per seat: rules digest (existing), `summarizeState(ownId)`
(existing), visible chat so far this window (existing `visibleChat`), own
remaining budget, and the two tools above.

## Humans

Humans use the existing manual chat box (already any-phase) plus a "done
talking" button during the window. No budget applies to humans — but their
messages still land in `chatLog` and therefore in the dump and in agents'
visible chat.

## UI

- **Diplomacy panel**: public stream + private threads (filter tabs),
  compose box with recipient picker (`All` / each living player), per-seat
  budget meter.
- **Spectator**: sees all traffic. Open decision: private messages are shown
  to spectators, clearly labeled "private". Recommended: yes — watchability
  is the point, and the dump records them anyway.
- **Budget display**: each player sees their own remaining budget; spectators
  see all four.

## The JSON dump

At game end (and on demand mid-game), the client offers the diplomacy record
as a downloadable JSON file. Schema:

```jsonc
{
  "gameId": "uuid",
  "seed": 12345,
  "scenario": "scenario-4p",
  "rounds": 9,
  "players": [
    { "id": 0, "name": "Player 1", "kind": "ai", "provider": "meta", "model": "muse-spark-1.3" }
  ],
  "diplomacy": {
    "budgetPerSeatPerRound": 2500,
    "backstopIterations": 12,
    "messages": [
      {
        "seq": 14, "round": 2,
        "sender": "Player 1", "recipients": "Player 3",
        "text": "...", "tokens": 142
      }
    ],
    "spend": { "0": { "1": 812, "2": 1403 }, "1": { "1": 0 } }
  },
  "result": { "winner": 2, "winReason": "capitals", "rounds": 9 }
}
```

Notes:

- `spend[pid][round]` = tokens that seat spent on diplomacy that round.
- The dump is also `console.log`ged for headless runs.
- This dump is the **raw material** for the deferred analysis work: once it
  exists, commitment extraction, betrayal detection, and alliance graphs can
  be built as offline passes over the JSON without touching the game.

## Cost envelope

Upper bound per game ≈ seats × budget × rounds. Example: 4 seats × 2500
tokens × 10 rounds ≈ 100K tokens of diplomacy worst-case — on the same
order as the rest of the game, and tunable via the single constant.

## Testing

- Unit: budget exhaustion silences a seat; backstop closes a window where
  nobody says done; delivery filtering (private message to P3 is invisible
  to P2's prompt — extend the isolation test); over-length/empty messages
  rejected without spending budget.
- E2E (scripted mocks): two bots exchange public + private messages across
  2 rounds; assert `chatLog` contents, dump schema validity, and spend
  accounting.
- No live-key requirement: diplomacy is transport + accounting; the model
  behavior it enables is evaluated later, offline, against dumps.

## Deferred to later (explicitly)

Commitment extraction, betrayal detection, alliance/disclosure analysis,
the reputation ledger in prompts, structured deals, agent chat outside the
window, streaming diplomacy UI.
