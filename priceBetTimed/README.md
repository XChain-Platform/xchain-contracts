# priceBetTimed: binary option settled by the first oracle round at/after a timestamp

The timestamp variant (v2) of the sibling [priceBet](../priceBet/) template. In
priceBet the parties agree on an oracle **round number** up front; here they
agree on a **settle time** (unix seconds, e.g. "Friday 15:00 UTC") and the bet is
decided by the **first finalized oracle round whose consensus timestamp is
at/after that instant**. Humans think in clock time, not round numbers; this
template translates one into the other deterministically.

## How settlement stays deterministic

There is no `getPriceAtBlock`/`getPriceAtTime` in the VM oracle API, and
settling on `getPrice()` ("latest right now") would let whoever calls first
pick a favorable moment. Instead:

- `accept()` records a scan **cursor** at the round current when the bet is
  matched (earlier rounds can never qualify: `accept()` requires block time <
  `settleTime`, and round timestamps are consensus history).
- `settle()` walks rounds upward from the cursor via `getPriceAtRound()`
  (immutable consensus values); the **first** round with `timestamp >=
  settleTime` decides. Gaps (skipped/disputed rounds) are stepped over. The
  walk is capped at 200 reads per call and the cursor persists, so any backlog
  pages across calls without exhausting gas.

The deciding round is a pure function of consensus history: any node, any
caller, any time: same winner. Assumes round timestamps are non-decreasing in
round number.

## settle() return values

| Return | Meaning |
|---|---|
| `SETTLED` / `PUSH` | Terminal: pot paid to the winner / stakes returned (tie). |
| `PENDING` | No round at/after `settleTime` exists yet. Valid no-op; try later. |
| `SCANNING` | Qualifying round exists but the 200-read cap was hit paging the backlog; cursor saved; call again. |

`PENDING`/`SCANNING` **return** rather than revert because a revert would
discard the cursor advance (state writes only commit on success).

## Methods

| Method | Who | Effect |
|---|---|---|
| `initialize(maker, coinPair, strike, side, tick, amount, settleTime, deadlineBlocks)` | deployer | Immutable terms; `settleTime` must be in the future; status → `INIT`. |
| `fund()` | maker (BATCH after DEPOSIT) | Escrows the stake; status → `OPEN`. |
| `accept()` | taker (BATCH after DEPOSIT) | Requires block time < `settleTime`; anchors cursor + void deadline; status → `MATCHED`. |
| `settle()` | anyone | See table above. |
| `cancel()` | maker | Reclaims the stake while unmatched. |
| `reclaim()` | maker or taker | Voids + refunds if no qualifying round exists `deadlineBlocks` after the match (O(1) guard: latest round's timestamp < `settleTime`). |
| `info()` | anyone | Terms + status + `settledRound` + winner. |

## Requirements / notes

- **Needs the modern oracle accessor**: `getPrice`/`getPriceAtRound` must
  return `{ price, roundNumber, timestamp }` objects (the indexer's
  `getOracleDataForVM` shape). A bare-string price carries no round metadata
  and settle reverts loudly (`oracle accessor lacks round metadata`).
- `reclaim()` cannot dodge a lost bet: it requires that **no** qualifying
  round exists; once one is finalized, `settle()` is the only path.

## Attacks we considered

All of the sibling [priceBet](../priceBet/README.md) protections apply
(balance-verified stakes, no self-match, terminal-status-before-emit guard,
`reclaim()` unusable once a deciding round exists, over-deposit drains on
refund, grid-floored refund legs, fixed-notation-only `amount` and `strike`
enforced at deploy, deferred-emission reentrancy model). The timestamp
translation adds its own surface:

- **Spot-price timing discretion.** Settling on `getPrice()` would let the
  first caller pick the moment. The deciding round is *the first finalized
  round with timestamp >= settleTime*, a pure function of consensus history:
  any node, any caller, any time, same winner.
- **Retroactive rounds qualifying.** `accept()` requires block time <
  `settleTime` and anchors the scan cursor at the round current at the match,
  so rounds finalized before the match can never decide the bet (their
  consensus timestamps predate it). The current round stays in scope as slack
  for clock skew between round consensus time and block time.
- **Gas exhaustion on a long round backlog.** The `settle()` walk is capped at
  200 `getPriceAtRound` reads per call (each a metered VM_STATE-class charge)
  and the cursor persists between calls, so an arbitrarily long stretch of
  pre-deadline rounds pages across calls (`SCANNING`) instead of making
  settlement impossible.
- **Losing the scan progress.** `PENDING`/`SCANNING` are *returns*, not
  reverts: a revert would discard the cursor advance (state writes only
  commit on success) and re-scan the same backlog forever.
- **Oracle gaps mis-deciding the bet.** Skipped/disputed rounds return null
  from `getPriceAtRound` and are stepped over; they can neither decide the
  bet nor wedge the walk.
- **Legacy oracle accessor mis-settling.** A bare-string price carries no
  round metadata; `latestRound()` reverts loudly (`oracle accessor lacks
  round metadata`) rather than settling on unverifiable data.
- **Dodging a loss via `reclaim()`.** The O(1) guard (latest round's
  timestamp < `settleTime`) means reclaim is only possible while *no*
  qualifying round exists anywhere; once one is finalized, `settle()` is the
  only path.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/priceBetTimed/priceBetTimed.test.js
```

Requires Node 22 (`isolated-vm`).
