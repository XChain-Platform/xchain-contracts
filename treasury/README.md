# Treasury

A poll-governed community treasury with a timelock and a guardian veto. Anyone
can deposit; funds leave only through a proposal that a binding `VOTE` poll has
approved, and even then only after a waiting period every holder can see coming.

## Why this template exists

In July 2026 an attacker spent $4.4M buying BONK, submitted a proposal to send
themselves $20M from the BonkDAO treasury, and passed it in a vote where 7 of
18,000+ eligible wallets participated. Nothing was hacked: the governance system
executed exactly as parameterized, and the transfer fired the moment the vote
closed. The failure was structural: quorum was cheap relative to the prize,
nobody saw the proposal, and there was no delay between "passed" and "paid".

This template is the safe-by-default counter-design. It stacks four defenses:

1. **Proposal gate.** Only holders of the governance token (at least
   `minProposeBalance` of it) can put a spend proposal in the queue.
2. **Poll binding (guardian mode).** A poll must be explicitly bound to its
   proposal by the guardian before it finalizes. A hostile look-alike poll can
   never arm anything.
3. **Timelock.** An armed proposal waits `timelockBlocks` before it can
   execute. The pending transfer (recipient, tick, amount) is public contract
   state for the whole window.
4. **Guardian veto.** The guardian can kill a proposal at any point before
   execution.

## Why the guardian exists (read before choosing `open` mode)

The `VOTE` finalization callback tells a contract *that* a poll passed, but the
protocol does not tell it *which token voted*: neither the callback arguments
nor `xchain.getPollResult` carry the poll's `TICK`. So a contract cannot verify
on-chain that "the community" voted rather than a worthless token the attacker
minted and fully controls, pointed at this treasury via `CALLBACK_CONTRACT`.

- **`guardian` mode (recommended):** a poll can only arm the proposal it was
  bound to via `approvePoll()`, and only the guardian can bind. The guardian
  verifies the poll off-chain before binding: right electorate token, real
  `QUORUM` and `MIN_VOTERS`, option 0 is the approval option. Fail-closed:
  an unbound poll is inert no matter how it voted.
- **`open` mode:** any passing poll that names a live proposal arms it. The
  timelock plus veto window is the only barrier between a hostile poll and the
  funds. Choose this only with an actively watching guardian and holders who
  will see the pending transfer in time. "Watch and react" is exactly what
  failed at BonkDAO; prefer `guardian` mode.

The guardian should be a multi-party address in production. It can censor
proposals (refuse to bind, veto) but can never move funds itself: there is no
withdraw path outside an executed proposal.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(guardian, govTick, timelockBlocks, executeWindowBlocks, minProposeBalance, mode)` | deployer | Sets immutable config. `mode` is `"guardian"` or `"open"`. |
| `propose(recipient, tick, amount, memo)` | any `govTick` holder with ≥ `minProposeBalance` | Records proposal N; status `PROPOSED`. Returns the id. |
| `approvePoll(proposalId, pollIndex)` | guardian (guardian mode only) | Binds the verified poll to the proposal. |
| `arm(...)` | the poll finalization callback only | Set as the binding poll's `CALLBACK_METHOD`. Verifies the result and starts the timelock; status `ARMED`. |
| `veto(proposalId)` | guardian | Kills a `PROPOSED` or `ARMED` proposal; status `VETOED`. |
| `cancel(proposalId)` | proposer | Withdraws a not-yet-armed proposal; status `CANCELLED`. |
| `executeProposal(proposalId)` | anyone | After the timelock, inside the execution window: re-verifies the poll via `getPollResult`, then sends exactly (recipient, tick, amount); status `EXECUTED`. |
| `info()` | anyone (read-only) | Config and proposal count. |
| `proposalInfo(proposalId)` | anyone (read-only) | One proposal record; reports `EXPIRED` for an armed proposal whose window passed. |

Funding needs no method call: `DEPOSIT` any tick to the contract address at any
time.

## Creating the governance poll

The proposer (or anyone) creates a binding `VOTE` v0 poll that follows these
conventions, then (guardian mode) asks the guardian to bind it:

- `TICK` = the governance token (the guardian verifies this; the contract
  cannot).
- `OPTIONS`: the approval option **first**. `arm()` rejects any winner other
  than option 0, so multi-option and "reject" polls cannot move funds.
- Set `QUORUM` and `MIN_VOTERS`. The protocol reports both gates as met when
  they were never configured, so the callback's gate check cannot distinguish
  "met" from "absent"; the guardian checks they are real before binding.
  Size the quorum so that buying it costs more than the treasury holds.
- `WEIGHT_MODE`: prefer `time_weighted`. It weights by holdings over a window,
  so tokens bought the day of the vote count for little; this directly defeats
  the buy-then-vote pattern.
- `CALLBACK_CONTRACT` = this contract's deploy action index,
  `CALLBACK_METHOD` = `"arm"`, `CALLBACK_PARAMS` = `[proposalId]`,
  `CALLBACK_ON` = `"pass"` (the default), and a `GAS_ESCROW` that covers
  `arm()`'s execution.

## Attacks we considered

- **The BonkDAO raid (buy tokens, pass your own spend).** In guardian mode the
  hostile poll never binds. In open mode it arms, but the transfer sits in
  public state for `timelockBlocks` while the guardian (or a holder alerting
  the guardian) vetoes. The poll conventions above (real quorum,
  `time_weighted`) raise the cost of even getting that far.
- **Spoofed poll on a junk token.** The protocol cannot tell the contract which
  token voted; see "Why the guardian exists". Guardian mode makes this inert;
  open mode leans on the timelock + veto.
- **Calling `arm()` directly.** The injected callback's `SOURCE` is the
  contract's own address, which no user action and no other contract's
  `emit.execute` can present (an emitted sub-action's source is the *emitting*
  contract). `arm()` requires exactly that identity, and this contract never
  calls itself.
- **Pointing a poll at `veto`/`approvePoll` instead.** Those methods check the
  caller against the stored guardian address; the callback identity (the
  contract's own address) fails that check.
- **Double execution.** `executeProposal` writes the terminal `EXECUTED` status
  in the same atomic scope as the `SEND` (emissions are deferred and applied
  with the state writes), so a second call sees the terminal status and
  reverts.
- **Executing a stale mandate.** An armed proposal that outlives
  `executeWindowBlocks` can never execute (reads as `EXPIRED`). Yesterday's
  vote cannot fire years later.
- **Reorg games at the finalize boundary.** `executeProposal` re-verifies the
  poll through `xchain.getPollResult`, which only exposes polls finalized in a
  strictly earlier block; the timelock guarantees execution is past that
  horizon, so the payout cross-checks the on-chain frozen tally, not just the
  armed state.
- **Queue spam.** `propose` requires `minProposeBalance` of the governance
  token, and the contract's own callback identity is explicitly barred from
  proposing.

## Known limitations (by design, for a teaching baseline)

- **The electorate is not verifiable on-chain.** Repeated because it is the
  big one: the protocol does not expose a poll's `TICK` to contracts, so
  `guardian` mode exists. If a future protocol change delivers the poll's tick
  to the callback or through `getPollResult`, `arm()` could pin
  `poll.tick === govTick` and open mode would become materially safer.
- **One transfer per proposal.** No batching, no streaming; deploy the vesting
  template from a proposal's recipient address if you need scheduled release.
- **The guardian can censor.** It cannot steal, but it can refuse to bind or
  veto everything. That is the intended trade for surviving voter apathy;
  communities that reject it should run `open` mode with a large timelock and
  real monitoring.
- **No quorum introspection.** The contract sees only met/not-met flags, which
  read "met" when the poll set no gates at all. Poll hygiene is the guardian's
  job (guardian mode) or the community's (open mode).

## Tests

`treasury.test.js` runs the real template through the VM (Node 22 /
isolated-vm):

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/treasury/treasury.test.js
```

## License

MIT. Fork it, ship it, change it. (The XChain *platform* is AGPL-3.0; these
*templates* are deliberately permissive so you can build proprietary contracts
on top.)
