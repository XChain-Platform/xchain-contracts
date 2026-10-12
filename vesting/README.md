# Vesting

A grantor locks tokens for a beneficiary that unlock gradually over time. The
beneficiary claims whatever has vested. With a **cliff**, nothing unlocks until
`cliffBlocks` have passed; after that the grant vests **linearly** and is fully
vested at `durationBlocks`. A grant can optionally be **revocable** - the grantor
reclaims the still-unvested portion, while the beneficiary keeps what they earned.

Time is measured in **blocks**, not wall-clock - XChain contracts have no clock,
only deterministic `getBlockHeight()`.

## Custody model

Same as [escrow](../escrow/) - there is no `msg.value`. Fund in one transaction
(read escrow's note: a `BATCH` is not atomic, so a reverted `fund()` leaves the
`DEPOSIT` standing in the contract):

```
BATCH( DEPOSIT(vesting, TICK, TOTAL), EXECUTE(vesting, "fund") )
```

`fund()` verifies the contract holds `total` (via `getBalance`) and starts the
vesting clock from that block - so there's no claimable gap before the grant is
actually in custody. Deposit **exactly** `total` of the configured tick; surplus
or other ticks are not recoverable by this template once the grant is funded.

`total` must fit the tick's decimal grid (for example no `1.5` on a 0-decimal
tick). `fund()` is the first point where the contract can read the tick's
decimals, so it refuses an off-grid `total` there. While the grant is still
`INIT`, the grantor can take back whatever deposit the contract holds with
`cancel()`, whether `fund()` refused the terms or the deposit was short.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(grantor, beneficiary, tick, total, cliffBlocks, durationBlocks, revocable)` | deployer | Sets terms; `revocable` is the string `"true"`/`"false"`; status → `INIT`. |
| `fund()` | grantor only (BATCHed after DEPOSIT) | Verifies custody ≥ `total`; starts the clock; status → `ACTIVE`. |
| `cancel()` | grantor (`INIT` only) | Returns the whole held deposit to the grantor; status → `CANCELLED`. |
| `claim()` | beneficiary | Sends vested-but-unclaimed tokens to the beneficiary. |
| `revoke()` | grantor (revocable grants only) | Returns the unvested portion to the grantor; freezes the vested cap; status → `REVOKED`. |
| `info()` | anyone (read-only) | `{ status, total, claimed, claimable }`; `claimable` is floored onto the tick's grid exactly as `claim()` pays it (template 1.3.0 and earlier report it unfloored). |

## The vesting curve

```
vested(now) =
    0                              if elapsed < cliffBlocks
    total                          if elapsed >= durationBlocks
    total * elapsed / durationBlocks   otherwise   (rounded DOWN)
```

`elapsed = now - start`. The cliff gates the *start* of vesting but not its slope:
at the cliff a chunk (`total * cliff / duration`) becomes claimable at once, then
it continues linearly. The division is computed at bignumber precision and every
payout is **floored onto the tick's decimal grid** before it is emitted, so the
contract **never over-pays** - each sub-grid remainder stays in custody, remains
claimable, and is released with a later claim (fully, once the grant vests or a
revoked grant's frozen cap is claimed).

## Attacks we considered

- **Caller lies about the deposit.** `fund()` reads the on-chain balance; an
  underfunded grant cannot be activated. The custody check is exact, not
  tolerance-based, so a deposit even one base unit short of `total` is rejected.
- **A total the tick cannot pay out.** Payouts are floored onto the tick's
  grid, so a `total` with more decimal places than the tick (`1.5` on a
  0-decimal tick) needed a deposit of the next grid step up while the
  beneficiary could only ever claim the step below, leaving a whole tick unit
  in custody for good. `fund()` refuses such a `total`, and `cancel()` returns
  the deposit. `cancel()` works only from `INIT`, so it can never pull back a
  funded grant, revocable or not.
- **Unauthorized claim.** `claim()` checks `getSourceAddress()` against the stored
  beneficiary - no one else can claim.
- **Someone else starts the clock.** `fund()` checks `getSourceAddress()` against
  the stored grantor. Otherwise, once custody reached `total` (after a top-up, or
  a deposit from another wallet), the beneficiary could start vesting at a block
  of their choosing and end the `INIT` window, blocking the grantor's `cancel()`
  for good. Template 1.3.0 and earlier let anyone call `fund()`.
- **Over-claim / double-claim.** Each claim pays `vested - claimed` and advances
  `claimed` in the same atomic execution; a repeat in the same block claims zero.
  Vested is capped at `total`, so the beneficiary can never extract more than the
  grant even long after full vesting.
- **Claim before funding.** Requires status `ACTIVE`/`REVOKED`; a fresh `INIT`
  grant pays nothing.
- **Revocation abuse.** `revoke()` is grantor-only, revocable-only, and reverts
  once fully vested. The grantor recovers the unvested remainder at revoke time,
  floored onto the tick's grid, and the beneficiary's cap freezes at the rest of
  `total`: what they had earned plus any sub-grid remainder (under one tick unit).
  Nothing further accrues, and the two payouts sum to exactly `total`, so no
  whole tick unit is left in custody. Template 1.3.0 and earlier froze the cap at
  the raw vested amount, which claim() floors again and which could strand up to
  two tick units.
- **A schedule that is not the one the deployer wrote.** `initialize(...)`
  requires `cliffBlocks` to be a canonical base-10 integer string in
  `[0, 1000000]` and `durationBlocks` in `[1, 1000000]`. That is a shape check,
  not a value parse: a radix-less `parseInt` silently re-measures `'1e3'` as `1`
  and `'0x10'` as `16`, so a grant the deployer asked to vest over 1000 blocks
  would have installed a 1-block duration and the beneficiary could drain the
  whole grant at the next block, while the DEPLOY params on chain still read
  `'1e3'` to anyone auditing them.
- **Rounding.** `xchain.math` bignumber throughout; no float literals
  (SDK-validated). Computed payouts can land off the tick's decimal grid
  (e.g. 2.666... on a 0-decimal tick), and the indexer re-normalises every
  emitted amount to the tick's decimals with half-up rounding (its bcmath is
  half-up, not banker's/half-even) - which can
  round UP past custody and revert the final tranche. Both `claim()` and
  `revoke()` therefore floor their payout onto the grid before emitting
  (same `floorToDecimals` treatment as the amm and crowdsale templates), and
  `claimed` advances by the floored amount actually paid.

## Known limitations (teaching baseline)

- **Single tick, exact funding.** Like escrow: deposit exactly `total` of the
  configured tick; once funded, surplus/other ticks are not recoverable.
  Before funding, `cancel()` returns everything the contract holds of the
  configured tick to the grantor, including tokens anyone else sent.
- **One beneficiary.** For team grants, deploy one vesting contract per grantee
  (cheap) rather than generalizing to a list.
- **Grantor trust on revocable grants.** A revocable grant lets the grantor cut
  it short. Use `revocable="false"` for trustless grants.

## Tests

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/vesting/vesting.test.js
```

## License

MIT - fork it, ship it, change it.
