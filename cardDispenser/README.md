# cardDispenser — random card-pack dispenser (inventory-backed, no mint)

A buyer pays a fixed `price` of `payTick` and receives **one unit of a random
card tick**, drawn from the contract's own deposited inventory with probability
**proportional to how many copies it holds**. Rarity is therefore set by stock:
stock 1000 commons and 10 legendaries and a legendary is 100× rarer. A sold-out
card (0 copies) is never drawn; when everything is sold out the payment is
refunded instead of stranded.

This is a **`emit.send` inventory** dispenser: it never mints. The prize pool is
whatever the operator DEPOSITs into the contract address for each card.

## Methods

| Method | Who | Effect |
|---|---|---|
| `initialize(payTick, price, unit, card1, card2, ...)` | deployer | Fixes the pay tick, per-draw price, per-draw card amount (`unit`), and the candidate card ticks. Records the deployer as `owner`. |
| `draw()` | buyer (BATCHed after DEPOSIT) | Verifies payment by balance delta, picks one in-stock card weighted by copies held, and `emit.send`s `unit` of it to the buyer. Refunds if sold out. |
| `withdraw(tick)` | owner | Sweeps the contract's entire balance of `tick` (collect `payTick` proceeds, pull leftover/retired cards). |
| `info()` | anyone | `{ payTick, price, unit, draws, stock }`. |

## Usage

The VM has no `msg.value`; pay and draw atomically in one transaction:

```
BATCH( DEPOSIT(contract, payTick, price), EXECUTE(contract, "draw") )
```

Fund the pool by DEPOSITing card tokens into the contract address before sales
open. The VM cannot enumerate holdings, so the candidate card ticks are fixed at
deploy time.

## Randomness — read before using for anything valuable

Entropy is `xchain.getBlockHash()`, which the indexer derives as
`sha256(blockHeight:blockTime)`. The output is uniform (good distribution;
modulo bias over a small set is ~1e-10), but the input is low-entropy and **a
miner can grind the block timestamp** to bias the result. Fine for low-value
card packs; for high-value randomness use commit-reveal or an attestation
oracle (`xchain.attestation`). The block hash is identical for every tx in a
block, so `draw()` mixes in the buyer address and a per-contract draw counter to
de-correlate same-block draws.

## Test

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/cardDispenser/cardDispenser.test.js
```

> ⚠️ **Deploying on-chain currently requires `getBalance()` to be wired in the
> indexer.** As of this writing `xchain-indexer/src/actions/execute.js` passes
> `balances: null` to the VM (a TODO), so `getBalance()` returns `null` in the
> live indexer — which blocks every custody template (escrow/vesting/crowdsale/
> amm too), not just this one. The VM E2E harness supplies balances, so the test
> above validates the contract logic regardless.
