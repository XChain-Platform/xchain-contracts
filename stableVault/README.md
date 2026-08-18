# stableVault: a mini-MakerDAO (over-collateralized stablecoin vaults)

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

- `getPrice(coinPair)`: latest finalized round, production object shape
  `{ price, roundNumber, timestamp }` (a bare string is also accepted).
- Price-sensitive ops (**borrow / withdraw-with-debt / liquidate**) require
  `getSnapshotAge() <= maxSnapshotAge` blocks: nobody acts on a stale price
  during an oracle outage.
- De-risking (**deposit / repay**) never touches the oracle: making a vault
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

`borrow(amount)` and `withdraw(amount)` require `amount` to be a **plain
fixed-notation decimal** (digits, at most one decimal point with digits on
both sides). It is a notation check, not a grid check: an on-grid value is
not required, because both methods floor the amount onto the tick's decimal
grid themselves. That flooring is exact string surgery which assumes fixed
notation, and `math.gt(amount, '0')` filters nothing - fed `'1.5e-8'` the
floor no-ops, the off-grid value reaches both the vault books and the wire,
and the ledger's HALF-UP re-rounding moves half a base unit more than the
books recorded, on every call.

## On-chain caveats (learned from the e2e run)

- **Declare `maxSupply`** in the emitted ISSUE: an unset cap reads as 0 and
  the indexer rejects every subsequent MINT.
- **Emitted amounts are normalized to the tick's decimals** at the ledger. A
  fractional amount (e.g. `2.75` of a 0-decimals collateral) gets rounded in
  the actual transfer, so a contract that booked the exact figure would drift
  from custody. `liquidate()`, `withdraw()`, and `borrow()` all floor the
  caller/seize amount onto the relevant tick's grid (`floorToDecimals`) before
  any ratio check, book write, or emission, so the indexer's normalization is a
  numeric no-op and custody == books holds exactly. Any new amount-bearing
  method must do the same.
- MINT on XChain is fair-mint flavored (caps and windows, not issuer-gated):
  on a real network, others could also MINT the stable tick within
  `maxSupply`. A production deployment would gate minting (allowList) or
  pre-mint into contract custody at ISSUE time.

## Attacks we considered

- **Caller lies about funding.** `deposit()`, `repay()`, and `liquidate()`
  never trust a caller-supplied amount: the credited amount is the custody
  delta (`actual balance - trackedColl/trackedStable`). You cannot be
  credited collateral, repay debt, or cover a liquidation with tokens the
  contract does not actually hold.
- **Un-BATCHed DEPOSIT claimed by a stranger.** A DEPOSIT without an
  immediately batched method call sits in the delta and is attributed to the
  next caller (same footgun as the crowdsale template). Always
  `BATCH(DEPOSIT, deposit/repay/liquidate)`.
- **Borrowing or withdrawing on a stale price.** Price-sensitive operations
  (`borrow`, `withdraw` with debt, `liquidate`) require
  `getSnapshotAge() <= maxSnapshotAge`; nobody can mint against or seize on a
  price frozen by an oracle outage. De-risking (`deposit`/`repay`, debt-free
  `withdraw`) deliberately skips the oracle so a vault can always be made
  safer.
- **Under-collateralized mint / exit.** `borrow()` and `withdraw()` check
  `collateral * price * 100 >= debt * minRatioPct` *after* the requested
  change, at the fresh price; `initialize` rejects `minRatioPct <= 100`
  (below 100% the stable would be under-backed by construction).
- **Liquidating a healthy vault.** `liquidate()` requires the vault to fail
  the ratio check at the fresh oracle price, requires the deposited stable to
  cover the *full* debt (burned), and caps the seizure at the vault's actual
  collateral. Excess stable is returned to the liquidator; leftover
  collateral stays credited to the owner.
- **Self-liquidation for the bonus.** `liquidate()` rejects
  `liquidator === vaultOwner`.
- **Rounding shortfall drains other vaults.** Every amount-bearing method
  (`liquidate()` seize, `withdraw()` and `borrow()` caller amounts) is floored
  to the relevant tick's decimal grid *before* the books are written
  (`floorToDecimals`). The indexer re-rounds every emitted amount HALF-UP
  at ledger-write time (its bcmath is half-up, not banker's/half-even); an
  off-grid amount rounded UP on the wire would debit
  custody more than the books, a pooled shortfall the last full-balance
  withdrawal would eat. Flooring makes the indexer's normalization a numeric
  no-op, so custody == books holds exactly on all three paths.
- **Uncapped stable supply.** The emitted ISSUE declares `maxSupply`
  (an unset cap reads as 0 and the indexer rejects every MINT). Note the
  fair-mint caveat below: on a real network others could MINT the stable
  tick within the cap; a production deployment gates minting.
- **Double payout / reentrancy.** Books (vault debt/collateral, totals,
  tracked custody) are written before the emissions, and emissions are
  deferred and applied atomically with the state writes after the method
  returns; there is no mid-method callback.
- **Rounding / float drift.** All arithmetic is `xchain.math` bignumber; the
  ratio check multiplies instead of dividing; no float literals (enforced at
  deploy).

## Deliberately NOT production-grade

No stability fees, partial liquidations, auctions, debt ceilings, multiple
collateral types, or emergency shutdown. The template shows the mechanism
(vaults, oracle-gated minting, permissionless liquidation) in its smallest
deterministic form.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/stableVault/stableVault.test.js
```

Requires Node 22 (`isolated-vm`).
