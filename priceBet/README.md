# priceBet — two-party binary option settled by the PRICE oracle

A maker deploys a bet with fixed terms: a coin pair (e.g. `BTC/USD`), a strike
price, a side (`OVER` / `UNDER`), a stake, and the **oracle round** that decides
the outcome. A taker matches the stake to take the opposite side. Once the
oracle publishes the agreed round, **anyone** can settle: strictly above the
strike pays the OVER side the whole pot, strictly below pays UNDER, exactly
equal is a push (both stakes returned).

Settlement reads `oracle.getPriceAtRound(pair, round)` — a consensus-finalized
historical value — so *when* `settle()` is called can never change *who* wins.
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
| `accept()` | taker (BATCH after DEPOSIT) | Verifies pot ≥ 2× stake; anchors the void deadline; status → `MATCHED`. |
| `settle()` | anyone | Reads the round price; pays the winner (or push-refunds both). |
| `cancel()` | maker | Reclaims the stake while unmatched; status → `CANCELLED`. |
| `reclaim()` | maker or taker | Voids the bet if the round is still unpublished after `deadlineBlocks`; refunds both. |
| `info()` | anyone | Read-only terms + status + winner. |

## Usage

Fund and act atomically (there is no `msg.value` on XChain):

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
- **Over-deposit drains on refund.** Push/void refunds give the maker exactly
  `amount` and the taker the remainder, so no dust strands in the contract.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/priceBet/priceBet.test.js
```

Requires Node 22 (`isolated-vm`).
