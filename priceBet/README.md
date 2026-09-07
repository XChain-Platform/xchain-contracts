# priceBet: two-party binary option settled by the PRICE oracle

A maker deploys a bet with fixed terms: a coin pair (e.g. `BTC/USD`), a strike
price, a side (`OVER` / `UNDER`), a stake, and the **oracle round** that decides
the outcome. A taker matches the stake to take the opposite side. Once the
oracle publishes the agreed round, **anyone** can settle: strictly above the
strike pays the OVER side the whole pot, strictly below pays UNDER, exactly
equal is a push (both stakes returned).

Settlement reads `oracle.getPriceAtRound(pair, round)` (a consensus-finalized
historical value), so *when* `settle()` is called can never change *who* wins.
That determinism is why settlement is permissionless.

## Lifecycle

```
INIT --fund()--> OPEN --accept()--> MATCHED --settle()--> SETTLED | PUSH
                   |                    |
                cancel()            reclaim() [deadline + round missing]
                   v                    v
               CANCELLED              VOID
```

## Methods

| Method | Who | Effect |
|---|---|---|
| `initialize(maker, coinPair, strike, side, tick, amount, settleRound, deadlineBlocks)` | deployer | Sets immutable terms; status → `INIT`. |
| `fund()` | maker (BATCH after DEPOSIT) | Verifies stake on deposit; status → `OPEN`. |
| `accept()` | taker (BATCH after DEPOSIT) | Requires the settle round to be still unpublished; verifies pot ≥ 2× stake; anchors the void deadline; status → `MATCHED`. |
| `settle()` | anyone | Reads the round price; pays the winner (or push-refunds both). |
| `cancel()` | maker | Reclaims the stake while unmatched; status → `CANCELLED`. |
| `reclaim()` | maker or taker | Voids the bet if the round is still unpublished after `deadlineBlocks`; refunds both. |
| `info()` | anyone | Read-only terms + status + winner. |

### Constructor term validation

`strike` and `amount` must be **plain fixed-notation decimals** (digits,
at most one decimal point with digits on both sides). `settleRound` and
`deadlineBlocks` must be canonical base-10 integers, in `[1, 1000000000]`
and `[1, 1000000]` respectively. Both checks are shape checks, not value
parses: `xchain.math` accepts exponential, hex and separator spellings of
a number, and a radix-less `parseInt` silently re-measures `'1e2'` as `1`
and `'0x10'` as `16`, so a maker who asked for a 100-block void window
would have got a 1-block one and a matched bet voidable almost at once.

## Usage

Fund and act in one transaction (there is no `msg.value` on XChain). A `BATCH` is
**not** atomic, so a reverted `fund()`/`accept()` leaves its `DEPOSIT` standing in
the contract:

```
BATCH( DEPOSIT(contract, TICK, stake), EXECUTE(contract, "fund") )    # maker
BATCH( DEPOSIT(contract, TICK, stake), EXECUTE(contract, "accept") )  # taker
EXECUTE(contract, "settle")                                           # anyone, once the round exists
```

## Design notes

- **Round-anchored, not spot-anchored.** Settling on `getPrice()` (current
  price) would let whoever calls first pick a favorable moment. Fixing the
  round in the terms removes all timing discretion.
- **`reclaim()` cannot dodge a loss.** It requires the round to be *missing*;
  once published, `settle()` is the only path.
- **State guard pattern.** Terminal status is written before any `emit.send`;
  the write and the emission commit atomically, so double-settlement is
  structurally impossible.
- **Over-deposit drains on refund.** Push/void refunds give the maker `amount`
  floored onto the tick's decimal grid and the taker the remainder, so no dust
  strands in the contract and neither leg is re-rounded at ledger-write time.

## Attacks we considered

- **Settlement timing discretion.** Settling on `getPrice()` (spot) would let
  whoever calls first pick a favorable moment. The deciding round is fixed in
  the deploy terms and read via `getPriceAtRound()`, a consensus-finalized
  historical value, so *when* `settle()` runs can never change *who* wins.
  That determinism is exactly why settlement is safe to leave permissionless.
- **Caller lies about the stake.** `fund()` and `accept()` ignore any
  caller-supplied amount and read the contract's own balance
  (`getBalance(self, tick)`). `accept()` requires the pot to hold both stakes
  (2x `amount`) before the bet arms.
- **Maker takes their own bet.** `accept()` rejects
  `taker === maker` (a self-match would let the maker void or settle at will
  with no counterparty at risk).
- **Sniping an open bet after the outcome is known.** Settlement is a pure
  function of consensus history, so the instant the settle round publishes the
  winner is public. `accept()` therefore requires that round to be still
  unpublished: an unmatched bet can never be taken as a free option on the
  maker's stake. `cancel()` stays the maker's escape and is unaffected.
- **Double settlement / replay.** Every payout path requires `MATCHED` (or
  `OPEN` for `cancel`) and writes a terminal status (`SETTLED` / `PUSH` /
  `VOID` / `CANCELLED`) before emitting; state writes and emissions commit
  atomically, so a second EXECUTE sees the terminal status and reverts.
- **Dodging a loss via `reclaim()`.** `reclaim()` requires the agreed round to
  be *missing*; once the oracle publishes it, `settle()` is the only path. A
  losing party cannot void a decided bet.
- **Maker cancels after the match.** `cancel()` requires status `OPEN`; once a
  taker has matched, the maker's stake is committed.
- **Void-window griefing.** The `deadlineBlocks` liveness window is anchored
  in `accept()`, when both stakes are actually at risk, not at deploy; a bet
  that sits unmatched for a while cannot arm already-expired.
- **Stranded over-deposit.** Push/void refunds give the maker `amount` floored
  onto the tick's decimal grid and the taker everything else, so accidental
  over-deposits drain with the refund instead of stranding in the contract.
- **Off-grid stake wedging the refund.** A stake carrying more decimals than
  the tick used to be emitted raw: at exactly half a base unit off the grid
  both refund legs re-rounded UP at ledger-write time, the pair exceeded
  custody, the taker's `SEND` threw and every `settle()`/`reclaim()` retry
  reverted with it. `refundBoth()` floors the maker leg, so both legs are
  already on-grid and the re-round is a no-op.
- **Mis-notated stake or strike.** Flooring alone did not close the above: the
  floor is string surgery that assumes fixed notation, and `math.gt(amount, '0')`
  accepts every spelling mathjs parses. A stake of `1.5e-8` slipped past the floor
  untouched and wedged the refund exactly as before, and `1.23456789e2` was
  *corrupted* to `1.23456789`, silently refunding the maker 1% of their stake and
  handing the remainder to the taker with no revert at all. `initialize()` now
  requires `amount` and `strike` to be plain fixed-notation decimals (digits, at
  most one interior decimal point), rejecting exponents, signs, radix prefixes,
  numeric separators and `Infinity` at deploy, before any funds can enter.
  Notation is gated there; the tick's decimal grid is still enforced by the floor
  in `refundBoth()`, because the tick's decimals are unreadable at deploy.
- **Reentrancy.** Emissions are deferred and applied by the indexer after the
  method returns, inside one atomic scope; there is no mid-method callback,
  and the terminal status is already written.
- **Rounding / float drift.** All comparisons and amounts use `xchain.math`
  bignumber ops; no float literals (enforced at deploy).

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/priceBet/priceBet.test.js
```

Requires Node 22 (`isolated-vm`).
