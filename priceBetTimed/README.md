# priceBetTimed: binary option settled by the first oracle round at/after a timestamp

The timestamp variant (v2) of the sibling [priceBet](../priceBet/) template. In
priceBet the parties agree on an oracle **round number** up front; here they
agree on a **settle time** (unix seconds, e.g. "Friday 15:00 UTC") and the bet is
decided by the **first finalized oracle round whose consensus timestamp is
at/after that instant**. Humans think in clock time, not round numbers; this
template translates one into the other deterministically.

## Deployer advisory: oracle stalls and the price freshness filter

**Read this before deploying, and check it against any instance you already
have live.** It describes a window in which the losing party can void a
decided bet, on nodes that have not yet reached the oracle stale-round
visibility activation height.

Nodes apply a freshness filter to `getPrice()`: a finalized round whose
consensus timestamp is older than the node's configured maximum price age (30
minutes by default) is not served as a current price. Before the activation
height the round is withheld **whole**, so `getPrice()` reports that no round
exists while `getPriceAtRound()` still holds that very round. This template
learns the newest round from `getPrice()`, so while an oracle stall outlasts
the freshness window:

- `settle()` reverts with `no oracle data yet`, even though the deciding round
  is finalized and readable in history, and
- `reclaim()` reads the same null as "no qualifying round ever arrived" and
  voids the bet once `deadlineBlocks` have passed.

Both stakes are returned, so nobody is robbed of principal, but the party who
LOST the bet gets to erase the result. The guard that normally prevents this
(`reclaim()` requires that no qualifying round exists) works exactly as
documented whenever the oracle is live; the stall is what blinds it.

At/after the activation height the node keeps the stale round with only its
PRICE withheld (`{ price: null, roundNumber, timestamp }`). The guard then
sees the round, refuses the void, and `settle()` decides the bet from
immutable history, which the freshness filter never touched. **This template
needs no change for that**: it already reads only the round number and
timestamp from `getPrice()`.

Until every node your instance depends on is past that height:

- **Settle promptly.** A bet that is settled before its deadline cannot be
  voided at all. The exposure needs all three of: the deadline passed, the
  deciding round finalized, and the oracle tip older than the freshness
  window.
- **Size `deadlineBlocks` well above the freshness window.** 30 minutes is
  roughly 3 BTC blocks; a deadline of a few blocks lets an ordinary stall
  reach the void, while a deadline of hundreds does not.
- **If a stall is in progress**, call `settle()` again as soon as the oracle
  publishes a fresh round: the guard blocks `reclaim()` from that block on.

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

### Constructor term validation

`strike` and `amount` must be **plain fixed-notation decimals** (digits,
at most one decimal point with digits on both sides). `settleTime` and
`deadlineBlocks` must be canonical base-10 integers, in
`[1, 253402300799]` (unix seconds, through year 9999) and `[1, 1000000]`
respectively. Both checks are shape checks, not value parses:
`xchain.math` accepts exponential, hex and separator spellings of a
number, and a radix-less `parseInt` silently re-measures `'1e2'` as `1`
and `'0x10'` as `16`, so a maker who asked for a 100-block void window
would have got a 1-block one, and a settle time spelled `'1.7e9'` would
have collapsed to a 1970 timestamp.

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
  only path. One case defeats the guard on nodes below the oracle stale-round
  visibility activation height, because there the newest round is hidden from
  `getPrice()` outright during a stall: see the deployer advisory at the top
  of this file.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/priceBetTimed/priceBetTimed.test.js
```

Requires Node 22 (`isolated-vm`).
