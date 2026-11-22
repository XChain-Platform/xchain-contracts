# stableVault: a mini-MakerDAO (over-collateralized stablecoin vaults)

A single-collateral stablecoin engine. Anyone deposits a collateral token
into a personal vault; against it the contract lends its stable token from a
pre-minted, mint-locked inventory as debt, as long
as the vault stays over-collateralized against the PRICE oracle:

```
collateral * price * 100  >=  debt * minRatioPct
```

Repaying returns stable to inventory. If the price falls and a vault
drops below the minimum ratio, **anyone** can liquidate it: the liquidator's
stable covers the full debt and returns to inventory while they seize collateral worth
`debt * (100 + liqBonusPct)%` at the oracle price, capped at the vault's
collateral. Leftover collateral still belongs to the vault owner.

## Custody and attribution

No `msg.value` on XChain: tokens enter via DEPOSIT, logic runs via EXECUTE, both
in one transaction with BATCH. A `BATCH` is **not** atomic, so an `EXECUTE` that
fails does not undo the `DEPOSIT` before it: the tokens stay in custody untracked,
and the next caller's delta credits them. A DEPOSIT carries no sender, so the
contract attributes
by **custody delta**: it tracks the totals it has accounted for
(`trackedColl`/`stableInventory`) and credits the caller of the batched EXECUTE
with `actual custody − tracked total`. The on-chain balance is the only source
of truth; caller-supplied funding amounts are never trusted.

## Oracle policy

- `getPrice(coinPair)`: latest finalized round, production object shape
  `{ price, roundNumber, timestamp }` (a bare string is also accepted).
- Price-sensitive ops (**borrow / withdraw-with-debt / liquidate**) require
  `getSnapshotAge() <= maxSnapshotAge` seconds, and, for the object shape,
  `getBlockTimestamp() - timestamp <= maxSnapshotAge` on the configured pair's
  own round. `getSnapshotAge()` is the newest round across every pair, so the
  second check is what stops a stalled pair hiding behind a fleet that keeps
  publishing. Set `maxSnapshotAge` above the pair's normal round interval, or
  these ops revert between rounds. A vault deployed from a revision before
  1.2.0 has only the fleet-wide check and must be redeployed to get the
  per-pair one.
- **Interim unit on live hosts.** The age is in seconds only once the host
  indexer's `oracle_snapshot_age_seconds_activation` is armed on the network.
  Before that the host returns a block count. On BTC that makes the window
  about 600x looser than its face value. On LTC and DOGE the value is the
  chain's own height minus a BTC reference height (millions), not an age, so
  `borrow`, `withdraw` with debt and `liquidate` revert `oracle price is
  stale` and an under-water vault cannot be liquidated. Do not deploy on LTC
  or DOGE before the activation is armed, and do not widen `maxSnapshotAge`
  into the millions to get around it, because that turns the freshness check
  off. A vault deployed from an earlier revision that measured
  `maxSnapshotAge` in blocks must be redeployed once the activation is armed.
- De-risking (**deposit / repay**) never touches the oracle: making a vault
  safer must never be blocked. A debt-free `withdraw` skips the oracle too.

## Methods

| Method | Who | Effect |
|---|---|---|
| `initialize(collateralTick, stableTick, coinPair, minRatioPct, liqBonusPct, maxSnapshotAge, stableDecimals)` | deployer | Immutable terms; pre-mints the full stable supply into custody and locks both mint paths. |
| `deposit()` | anyone (BATCH after collateral DEPOSIT) | Credits the caller's vault with the custody delta. |
| `borrow(amount)` | vault owner | Ratio check at the fresh price, then sends from stable inventory. |
| `repay()` | vault owner (BATCH after stable DEPOSIT) | Returns up to the debt to inventory and refunds any excess. |
| `withdraw(amount)` | vault owner | Blocked below the minimum ratio; oracle-free when debt is 0. |
| `liquidate(vaultOwner)` | anyone (BATCH after stable DEPOSIT ≥ debt) | Under-water vaults only; returns debt to inventory and pays collateral plus bonus. |
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

`initialize(...)` requires `maxSnapshotAge` to be a canonical base-10 integer
in `[1, 31536000]` seconds. That is a shape check, not a value parse: a
radix-less `parseInt` silently re-measures `'1e3'` as `1` and `'0x10'` as
`16`, so a deployer who asked for a 1000-second staleness window would have
got a 1-second one, and `freshPrice` would then revert `borrow`, `withdraw`
and `liquidate` on every call whenever the oracle publishes less often than
once per second.

`stableDecimals` (optional, default `8`) is the decimal grid of the stable this
contract issues, and gets the same integer-shape check in `[0, 18]`. It is a
deploy-time parameter rather than a ledger read on purpose. It remains a
constructor term and not a mutable ledger dependency. `initialize` declares
the grid on the `emit.issue` (ISSUE defaults decimals to `0` and locks them once
supply exists) and stores the same value for `borrow` to floor against. The
collateral tick keeps its ledger-derived decimals: the contract really does hold
that one.

## On-chain caveats (learned from the e2e run)

- **Lock public minting.** XChain MINT is not issuer-gated. The ISSUE therefore
  pre-mints the full cap into contract custody and sets `lockMint` and
  `lockMintSupply`; borrow distributes only that inventory. The ledger SUPPLY
  of the stable therefore stays at the cap: read outstanding stable from
  `info().totalDebt`, not from SUPPLY. Vaults deployed from a revision before
  2.0.0 left MINT public and should be redeployed.
- **The deployer can still WITHDRAW custody where owner WITHDRAW is
  allowed.** A raw `WITHDRAW` moves a contract's custody to its deployer
  without running contract code. From the `OWNER_WITHDRAW_OPT_IN` activation a
  contract that does not declare `meta.ownerWithdraw` (this one does not)
  refuses it, but on a network where that rule was not active at the deploy
  block the deployer can take borrowers' collateral and the pre-minted stable
  inventory. That stable is unbacked, and while custody holds less stable than
  `stableInventory` the gap absorbs the next deposits, so `repay()` and
  `liquidate()` credit less than was sent or revert. Users of such a vault are
  trusting the deployer.
- **Emitted amounts are normalized to the tick's decimals** at the ledger. A
  fractional amount (e.g. `2.75` of a 0-decimals collateral) gets rounded in
  the actual transfer, so a contract that booked the exact figure would drift
  from custody. `liquidate()`, `withdraw()`, and `borrow()` all floor the
  caller/seize amount onto the relevant tick's grid (`floorToDecimals`) before
  any ratio check, book write, or emission, so the indexer's normalization is a
  numeric no-op and custody == books holds exactly. Any new amount-bearing
  method must do the same.

## Attacks we considered

- **Caller lies about funding.** `deposit()`, `repay()`, and `liquidate()`
  never trust a caller-supplied amount: the credited amount is the custody
  delta (`actual balance - trackedColl/stableInventory`). You cannot be
  credited collateral, repay debt, or cover a liquidation with tokens the
  contract does not actually hold.
- **Un-BATCHed DEPOSIT claimed by a stranger.** A DEPOSIT without an
  immediately batched method call sits in the delta and is attributed to the
  next caller (same footgun as the crowdsale template). Always
  `BATCH(DEPOSIT, deposit/repay/liquidate)`.
- **State-key exhaustion.** At most 4,900 vaults can be live. That reserves
  both the collateral and debt key for every admitted vault under the VM's
  10,000-key cap. A new depositor at the ceiling receives their full custody
  delta back instead of leaving it unattributed, while keys are deleted when
  their values reach zero so honest churn frees slots. An attacker can still
  fill every slot with dust vaults and lock newcomers out, but the refused
  newcomers are refunded rather than having their collateral credited to the
  next caller. Earlier template revisions had no ceiling and should be
  redeployed before accepting more collateral.
- **Borrowing or withdrawing on a stale price.** Price-sensitive operations
  (`borrow`, `withdraw` with debt, `liquidate`) require both
  `getSnapshotAge() <= maxSnapshotAge` and the configured pair's own round
  to be no older than `maxSnapshotAge`; nobody can mint against or seize on a
  price frozen by an oracle outage, even one confined to this pair. De-risking (`deposit`/`repay`, debt-free
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
- **Overdrawing the shared pool by a tolerance band.** `xchain.math.gte`
  treats values within 1e-12 relative of each other as equal, which at a
  1,000,000 balance is 100 base units of an 8-decimal tick. `withdraw()`'s
  collateral check and `liquidate()`'s full-debt check therefore compare
  exactly (`isAtLeastExact`), so a debt-free vault cannot take collateral
  that belongs to other vaults. The collateral ratio check in `borrow()`,
  `withdraw()` and `liquidate()` is exact too, so no vault is left up to
  1e-12 relative below `minRatioPct`, and the "has debt" checks use the exact
  `exceedsExactly`: with `stableDecimals` above 15 a tolerant `gt` reads a
  debt at or below 1e-15 as zero, letting `withdraw()` empty a vault that
  still owes it and leaving that debt unliquidatable. Vaults deployed before 1.3.0
  keep the tolerant comparisons.
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
- **Outside MINT and cap exhaustion.** The full capped supply is pre-minted to
  custody with both mint paths locked. An outside address cannot create
  uncollateralized stable or fill the remaining cap ahead of borrowers.
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
