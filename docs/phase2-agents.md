# Phase 2 agents - BYOK design (implemented in `agents/`)

> **Status: implemented and merged to `main`.** The Phase 2 MVP shipped
> in PR #12, the M2 browser UI in PR #18, and M3 diplomacy in PR #22. The
> Meta adapter was live-verified on 2026-10-04 and the Anthropic adapter
> on 2026-10-31; the OpenAI adapter is implemented per the provider's
> current API docs and is covered by mocked tests. The engine's
> action API (`purchase`, `combatMove`, `resolveCombatRound`, `autoCasualties`,
> `nonCombatMove`, `mobilize`, `sendMessage`, `summarizeState`) is the LLM tool
> set with no translation layer - see `agents/tools.ts` for the JSON-Schema
> versions and `docs/architecture.md` ("How a Phase 2 agent drives one turn")
> for the call order.

## The idea

One browser tab hosts the whole game. Each seat is Human or AI; each AI seat
is **its own LLM instance** (provider + model + the host's API key), driven by
a local turn loop. No backend, no key server - visitors bring their own keys
(BYOK) and pay for their own tokens.

## Single-browser host model

- The lobby (`agents/lobby.ts`) builds one `SeatConfig` per player:
  `{ seatIndex, playerId, kind: 'human'|'ai', provider?, model?, keySlot? }`.
- The driver (`agents/driver.ts`, `runGame`) walks the 6 phases in turn order.
  Human seats yield through an `onHumanTurn` callback (the UI acts on the
  state directly, then resolves); AI seats go through their `Agent`.
- The host can spectate an all-AI game or take a seat in a mixed game.
- Keys live only in the host's browser (`agents/keys.ts`, `localStorage`
  `aaa.byok.<provider>`, memory-only when "remember" is off) and are sent only
  to the chosen provider's API. Adapters never log or persist keys.

## Providers (v1): Anthropic, OpenAI, Meta

`agents/providers/` implements one common interface -
`complete({ apiKey, model, system, transcript, tools })` - with per-provider
adapters:

| Provider | Endpoint | Auth | Notes |
|---|---|---|---|
| Anthropic | `POST https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` | Sends `anthropic-dangerous-direct-browser-access: true` for browser CORS. Never sends `temperature` (non-default 400s on current models). |
| OpenAI | `POST https://api.openai.com/v1/chat/completions` | `Bearer` | Standard function-tools shape; browser CORS is fine. |
| Meta | `POST https://api.meta.ai/v1/chat/completions` | `Bearer` | The **Meta Model API** (Muse Spark models) - what dev.meta.ai issues keys for. Not the Llama API (`api.llama.com`), a separate product with separate keys. OpenAI-compatible shape; verified live 2026-10-04. |

Curated v1 models (**IDs roll forward, refresh periodically** - Anthropic
list verified live 2026-10-31, Meta list live-verified 2026-10-04, OpenAI
list not yet live-verified):
Anthropic `claude-sonnet-5` (default), `claude-opus-5`, `claude-haiku-4-5`,
`claude-fable-5-1`; OpenAI `gpt-5.6` (default), `gpt-5.5`, `gpt-5.4-mini`,
`gpt-5-mini`, `gpt-4.1`; Meta `muse-spark-1.3` (default), `muse-spark-1.3-contributor`,
`muse-spark-1.2`, `muse-spark-1.1` (live-verified 2026-10-04; voice/image variants
skipped - not chat models. The Contributor tier lets Meta train on your data;
it's in the picker by request, not by default). Haiku note: the account
models list reports only the dated `claude-haiku-4-5-20251001`; the curated
`claude-haiku-4-5` alias was confirmed against `/v1/messages` live on
2026-10-31 and resolves to that snapshot.

## Streaming

`CompleteRequest.onToken`, when set, makes the OpenAI-compatible adapter send
`stream: true` and forward each text delta to the callback as it arrives; the
returned `CompleteResponse` is identical in shape to a non-streaming call.
`Agent.act()` / `diplomacyAct()` accept it as an optional trailing argument
and forward it - callers that don't pass it get the plain non-streaming
round-trip, unchanged. The browser UI (`ui/aiGame.ts` `UiAgent`) streams every
turn into the seat card's rationale live, so a 30s turn shows its thinking
instead of a dead "Thinking…" status. Streaming also dodges Meta's
504-on-long-non-streaming-requests behavior. The Anthropic adapter ignores
`onToken` (non-streaming only) for now.

## Per-player isolation

Each AI seat gets its own `Agent` instance (`agents/agent.ts`). Prompts are
built **only** from: the static rules digest (`agents/prompts.ts`), the seat's
own name/persona, `summarizeState(ownPlayerId)`, its own private history, and
`chatLog` messages actually addressed to it (broadcast or by name). No agent
can see another's system prompt, reasoning, or history - this is structural
(no shared state), and `tests/agents/isolation.test.ts` asserts it.

## Tool parity and the turn loop

- `agents/tools.ts` exposes the 9 canonical tools with a per-phase allowlist
  (e.g. only `purchase` + `end_phase` during purchase). The UI harness uses
  the same schemas - one tool surface for humans and LLMs.
- **Batched turns (2 LLM calls, not 4):** an AI turn is two provider
  round-trips. Group A ("assault") plans purchase + combat move from the
  pre-turn state; combat then auto-resolves locally with no LLM; group B
  ("consolidate") plans non-combat + mobilize from the post-combat state.
  This is exact, not approximate: purchase/combatMove/mobilize are all
  decidable from the pre-turn state (purchased units can't fight until
  placed; mobilize depends only on the purchase list + turn-start factories,
  and factories captured this turn come online next turn). Only non-combat
  needs post-combat state. `Agent.actGroup()` builds the group prompt
  (`buildGroupPrompt`) and the union tool allowlist (`toolsForGroup`); the
  driver partitions returned tool calls by tool name and applies them in
  canonical phase order. `act()` (single phase) is unchanged and still used
  by diplomacy/human paths.
- **Phase skipping:** before each phase the driver runs a cheap local
  affordance check (`agents/affordance.ts`) - e.g. purchase is skipped when
  the bank can't cover the cheapest unit or the capital is enemy-held,
  mobilize when nothing was purchased. Skipped phases end directly with an
  `onPhaseSkipped` event and no LLM call. All checks are conservative: a
  missed skip costs one wasted call, a wrongful skip would drop agency.
- Per phase the driver applies tool calls via `dispatchTool` (engine
  validation **is** the validation step - failed actions never mutate
  state). On rejection the valid prefix **stays applied**; the driver
  re-plans the failed phase plus the not-yet-executed later phases in one
  fresh call (max 3 retries per phase), with the `rejected [code]: reason`
  tool result in history as feedback. Then it falls back to a safe default
  (pass / no moves / forfeit unplaced).
- After each batch, the driver records every tool call's outcome back into
  the agent (`Agent.recordToolResults`) as `{role:'tool'}` history entries -
  provider APIs require each assistant `tool_calls` entry to have a matching
  tool response, and the feedback tells the model what was rejected and why
  before its next attempt. `tests/agents/tool_results.test.ts` enforces the
  transcript invariant.
- Combat (MVP): the driver auto-resolves - `resolveCombatRound` +
  `autoCasualties` on both sides until every battle ends. The agent decides
  *where* to attack (`combat_move`), not casualty-by-casualty. `retreat` and
  `chooseCasualties` exist as tools for later sophistication.
- `act()`/`actGroup()` are a single provider round-trip each by design (no
  blind ReAct loop - tool results live with the driver, so looping without
  them would just burn tokens). Multi-action phases are expressed as
  multiple tool calls in one response; `end_phase` from the model means "I'm
  done" (in batched turns it is optional - phases advance automatically).
- Negotiation: `send_message` plumbing works end-to-end, but
  agent-initiated chat is **disabled in the MVP** (v2).

## Cost and safety

- Every provider round-trip records `{inputTokens, outputTokens, calls}`;
  engine-validation rejections increment `errors`. `runGame` returns
  per-player usage - the raw material for per-game budgets and tournament
  cost attribution. Providers that report it also fill `cachedInputTokens`
  (subset of `inputTokens`).
- **Prompt caching (Meta):** the system prompt ends with a static map/unit
  reference (`agents/prompts.ts`: `STATIC_REFERENCE`) that is byte-identical
  on every call, so api.meta.ai reuses the leading prefix automatically -
  cached input tokens are ~8x cheaper and skip prefill work. Everything
  volatile (history window, fresh state brief) stays after it. The agent sends
  a stable `prompt_cache_key` derived from the reference (shared across
  seats; any map/data change re-keys automatically) plus a `"24h"` retention
  hint for the bursty gaps between games. Watch `cachedInputTokens /
  inputTokens` to confirm the prefix is actually being reused.
- `MaxRoundsExceeded` guards runaway games (default `max(turnCap + 5, 60)`).
- Engine RNG stays seeded and replayable; prompts + responses should be
  logged per game for audit (tournament harness work).

## Testing

- `tests/agents/`: adapter unit tests with mocked `fetch` (endpoints, headers,
  tool payloads, error paths), key-store tests, tool-schema/allowlist tests,
  the isolation test, and headless end-to-end games through the driver with
  scripted mock providers (`tests/agents/mock.ts`): full 4-player games to
  `gameover`, greedy-bot games with real combat, retry and fallback paths, and
  a human seat - all asserting engine invariants (`assertValidUnits`-style).
- **Live-key testing:** done for Meta on 2026-10-04 - a real Model API seat
  (`muse-spark-1.3`) played 3 full rounds vs 3 scripted seats through the real
  driver: 19 provider calls, ~120K tokens, 8 engine-rejected tool calls all
  handled by retry/fallback, no illegal state. That run caught the tool-result
  history bug fixed above. Anthropic live testing ran on 2026-10-31: the
  account models list was checked against the curated catalog, a tool-call
  smoke with the game's real tool schemas succeeded, and the tool-result
  round trip exposed a serialization defect - the adapter replayed an empty
  text block for tool-only assistant replies, which the API rejects with
  HTTP 400. The fix (omit empty text blocks; a reply with neither text nor
  tool calls gets a placeholder block) is covered by mocked regression
  tests, and the fixed round-trip shape was re-confirmed live the same day.
  OpenAI live testing has not been run; its adapter is implemented per the
  provider's current docs (endpoints/headers) and covered by mocked tests.

## Milestones

- **M1** (done, merged): headless-validated driver - mock providers play
  full legal games; architecture + basic tools; no negotiation.
- **M2** (done, merged): mixed human+AI in the browser - lobby
  screen with per-seat provider/model/BYOK key inputs, single-tab game
  runner, spectator panel (rationale, tool calls, per-seat usage), human
  seats via the existing hot-seat UI, seat-level failure recovery, pause /
  resume. No negotiation.
- **M3** (done, merged): diplomacy - see [the M3 diplomacy doc](m3-diplomacy.md).
  Freeform talk (public + private DMs) with per-seat token budgets instead
  of chat rules, plus an end-of-game JSON dump as the raw material for later
  analysis. Commitment extraction, betrayal detection, alliance graphs, and
  the reputation ledger are deferred until the dump exists to parse.
  Heterogeneous model matchups (Claude vs ChatGPT vs Meta), Elo + replay
  export, per-game cost budgets.
- **M4**: hosted runner (for players without keys / tournament play).

## Non-goals

No engine redesign. If Phase 2 needs an engine change, the abstraction leaked -
fix the abstraction, not the caller. `engine/`, `data/`, `.github/` are
untouched by this branch.
