# priceBetTimed — binary option settled by the first oracle round at/after a timestamp

The timestamp variant (v2) of the sibling [priceBet](../priceBet/) template. In
priceBet the parties agree on an oracle **round number** up front; here they
agree on a **settle time** (unix seconds — "Friday 15:00 UTC") and the bet is
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
caller, any time — same winner. Assumes round timestamps are non-decreasing in
round number.

## settle() return values

| Return | Meaning |
|---|---|
| `SETTLED` / `PUSH` | Terminal: pot paid to the winner / stakes returned (tie). |
| `PENDING` | No round at/after `settleTime` exists yet. Valid no-op; try later. |
| `SCANNING` | Qualifying round exists but the 200-read cap was hit paging the backlog; cursor saved — call again. |

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

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/priceBetTimed/priceBetTimed.test.js
```

Requires Node 22 (`isolated-vm`).
