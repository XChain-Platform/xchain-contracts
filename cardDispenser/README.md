# cardDispenser: random card-pack dispenser (inventory-backed, no mint)

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

The VM has no `msg.value`; pay and draw in one transaction. A `BATCH` is **not**
atomic, so a reverted `draw()` leaves its `DEPOSIT` standing (see "Sold-out
payment stranding" under [Attacks we considered](#attacks-we-considered)):

```
BATCH( DEPOSIT(contract, payTick, price), EXECUTE(contract, "draw") )
```

Fund the pool by DEPOSITing card tokens into the contract address before sales
open. The VM cannot enumerate holdings, so the candidate card ticks are fixed at
deploy time.

## Randomness (read before using for anything valuable)

Entropy is `xchain.getBlockHash()`, which the indexer derives as
`sha256(blockHeight:blockTime)`. The output is uniform (good distribution;
modulo bias over a small set is ~1e-10), but the input is low-entropy and **a
miner can grind the block timestamp** to bias the result. Fine for low-value
card packs; for high-value randomness use commit-reveal or an attestation
oracle (`xchain.attestation`). The block hash is identical for every tx in a
block, so `draw()` mixes in the buyer address and a per-contract draw counter to
de-correlate same-block draws.

## Attacks we considered

- **Caller lies about the payment.** `draw()` never trusts a caller-supplied
  amount; it computes the payment as the delta of the contract's `payTick`
  balance since the last accounted draw (`acctPay`). Underpayment reverts.
- **Un-BATCHed DEPOSIT credited to a stranger.** A DEPOSIT without an
  immediately batched `draw()` sits in the delta and is claimed by the next
  caller of `draw()` (same footgun as the crowdsale template). Always
  `BATCH(DEPOSIT, draw)`. Overpayment inside a batch is kept as a tip by
  design, so on a *dispensing* draw `acctPay` advances to the full balance.
  Where `payTick` LEAVES custody the watermark follows it down instead: the
  sold-out refund advances it only to the post-refund balance, and
  `withdraw(payTick)` resets it to `0`. Any outflow path a fork adds must do
  the same, or `draw()` measures a delta the contract no longer holds and
  reverts `'underpaid'` for good.
- **Same-block draw correlation.** The block hash is identical for every tx in
  a block, so a naive seed would give every same-block buyer the same card.
  `pick()` mixes in the buyer address and a per-contract draw counter (nonce)
  so same-block draws de-correlate by construction.
- **Miner grinds the entropy.** `getBlockHash()` derives from
  `sha256(blockHeight:blockTime)`; a miner can grind the timestamp to bias a
  draw. This is an accepted, documented limitation for low-value packs (see
  the Randomness section); for high-value randomness use commit-reveal or an
  attestation oracle instead of this template.
- **Sold-out payment stranding.** If `draw()` reverted when stock is empty,
  the batched DEPOSIT before it would NOT roll back and the buyer's payment
  would strand in the contract. Instead the payment is refunded and
  `'sold_out'` is returned as a valid execution.
- **Card-list injection at deploy.** `initialize` rejects card ticks
  containing the `|` state delimiter and rejects a card tick equal to
  `payTick` (which would let payments masquerade as stock).
- **Fractional stock inflation.** Copies are `floor(balance / unit)`, so a
  dust deposit below one `unit` adds zero draw weight and can never dispense a
  partial card.
- **Unauthorized sweep.** `withdraw(tick)` is owner-only
  (`getSourceAddress()` checked against the stored deployer).
- **Rounding / float drift.** All arithmetic uses `xchain.math` bignumber ops;
  there are no float literals (the deploy-time validator enforces this).

## Test

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/cardDispenser/cardDispenser.test.js
```

> **On-chain deployment note.** `getBalance()`/`getTokenInfo()` are wired in
> the live indexer: `xchain-indexer/src/actions/execute.js` builds a balance
> and token-info snapshot (scoped to the caller plus this contract's own
> address) and passes it to the VM, gated on the `VM_BALANCE_TOKENINFO`
> flag-day. The flag is active from genesis on testnet/regtest and since
> 2026-08-07 00:00 UTC on mainnet, so this and the other custody templates
> (escrow/vesting/crowdsale/amm) deploy and read balances on-chain. The VM E2E
> harness supplies balances directly, so the test above validates the contract
> logic on its own.
