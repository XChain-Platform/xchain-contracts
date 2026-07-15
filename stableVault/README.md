# stableVault — a mini-MakerDAO: over-collateralized stablecoin vaults

A single-collateral stablecoin engine. Anyone deposits a collateral token
into a personal vault; against it the **contract mints its own stable token**
(`emit.issue` at deploy, `emit.mint` + `emit.send` on borrow) as debt, as long
as the vault stays over-collateralized against the PRICE oracle:

```
collateral * price * 100  >=  debt * minRatioPct
```

Repaying burns the stable (`emit.destroy`). If the price falls and a vault
drops below the minimum ratio, **anyone** can liquidate it: the liquidator's
stable covers the full debt (burned) and they seize collateral worth
`debt * (100 + liqBonusPct)%` at the oracle price, capped at the vault's
collateral. Leftover collateral still belongs to the vault owner.

## Custody and attribution

No `msg.value` on XChain: tokens enter via DEPOSIT, logic runs via EXECUTE,
atomically with BATCH. A DEPOSIT carries no sender, so the contract attributes
by **custody delta**: it tracks the totals it has accounted for
(`trackedColl`/`trackedStable`) and credits the caller of the batched EXECUTE
with `actual custody − tracked total`. The on-chain balance is the only source
of truth; caller-supplied funding amounts are never trusted.

## Oracle policy

- `getPrice(coinPair)` — latest finalized round, production object shape
  `{ price, roundNumber, timestamp }` (a bare string is also accepted).
- Price-sensitive ops (**borrow / withdraw-with-debt / liquidate**) require
  `getSnapshotAge() <= maxSnapshotAge` blocks: nobody acts on a stale price
  during an oracle outage.
- De-risking (**deposit / repay**) never touches the oracle — making a vault
  safer must never be blocked. A debt-free `withdraw` skips the oracle too.

## Methods

| Method | Who | Effect |
|---|---|---|
| `initialize(collateralTick, stableTick, coinPair, minRatioPct, liqBonusPct, maxSnapshotAge)` | deployer | Immutable terms; `emit.issue`s the stable with the contract as issuer. |
| `deposit()` | anyone (BATCH after collateral DEPOSIT) | Credits the caller's vault with the custody delta. |
| `borrow(amount)` | vault owner | Ratio check at the fresh price, then `emit.mint` + `emit.send`. |
| `repay()` | vault owner (BATCH after stable DEPOSIT) | Burns up to the debt, refunds any excess. |
| `withdraw(amount)` | vault owner | Blocked below the minimum ratio; oracle-free when debt is 0. |
| `liquidate(vaultOwner)` | anyone (BATCH after stable DEPOSIT ≥ debt) | Under-water vaults only; burns the debt, pays collateral + bonus. |
| `vault(addr)` / `info()` | anyone | JSON views of a vault / the system. |

## On-chain caveats (learned from the e2e run)

- **Declare `maxSupply`** in the emitted ISSUE: an unset cap reads as 0 and
  the indexer rejects every subsequent MINT.
- **Emitted amounts are normalized to the tick's decimals** at the ledger. A
  fractional seizure (e.g. `2.75` of a 0-decimals collateral) gets rounded in
  the actual transfer while the contract state keeps the exact figure — the
  vault accounting drifts from custody. Pick `liqBonusPct` and price grids
  that keep amounts on the tick's grid, or add explicit rounding.
- MINT on XChain is fair-mint flavored (caps and windows, not issuer-gated):
  on a real network, others could also MINT the stable tick within
  `maxSupply`. A production deployment would gate minting (allowList) or
  pre-mint into contract custody at ISSUE time.

## Deliberately NOT production-grade

No stability fees, partial liquidations, auctions, debt ceilings, multiple
collateral types, or emergency shutdown. The template shows the mechanism —
vaults, oracle-gated minting, permissionless liquidation — in its smallest
deterministic form.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/stableVault/stableVault.test.js
```

Requires Node 22 (`isolated-vm`).
