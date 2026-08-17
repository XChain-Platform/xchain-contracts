# Vesting

A grantor locks tokens for a beneficiary that unlock gradually over time. The
beneficiary claims whatever has vested. With a **cliff**, nothing unlocks until
`cliffBlocks` have passed; after that the grant vests **linearly** and is fully
vested at `durationBlocks`. A grant can optionally be **revocable** - the grantor
reclaims the still-unvested portion, while the beneficiary keeps what they earned.

Time is measured in **blocks**, not wall-clock - XChain contracts have no clock,
only deterministic `getBlockHeight()`.

## Custody model

Same as [escrow](../escrow/) - there is no `msg.value`. Fund atomically:

```
BATCH( DEPOSIT(vesting, TICK, TOTAL), EXECUTE(vesting, "fund") )
```

`fund()` verifies the contract holds `total` (via `getBalance`) and starts the
vesting clock from that block - so there's no claimable gap before the grant is
actually in custody. Deposit **exactly** `total` of the configured tick; surplus
or other ticks are not recoverable by this template.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(grantor, beneficiary, tick, total, cliffBlocks, durationBlocks, revocable)` | deployer | Sets terms; `revocable` is the string `"true"`/`"false"`; status → `INIT`. |
| `fund()` | grantor (BATCHed after DEPOSIT) | Verifies custody ≥ `total`; starts the clock; status → `ACTIVE`. |
| `claim()` | beneficiary | Sends vested-but-unclaimed tokens to the beneficiary. |
| `revoke()` | grantor (revocable grants only) | Returns the unvested portion to the grantor; freezes the vested cap; status → `REVOKED`. |
| `info()` | anyone (read-only) | `{ status, total, claimed, claimable }`. |

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
claimable, and is released with a later claim (fully, once the grant vests).

## Attacks we considered

- **Caller lies about the deposit.** `fund()` reads the on-chain balance; an
  underfunded grant cannot be activated.
- **Unauthorized claim.** `claim()` checks `getSourceAddress()` against the stored
  beneficiary - no one else can claim.
- **Over-claim / double-claim.** Each claim pays `vested - claimed` and advances
  `claimed` in the same atomic execution; a repeat in the same block claims zero.
  Vested is capped at `total`, so the beneficiary can never extract more than the
  grant even long after full vesting.
- **Claim before funding.** Requires status `ACTIVE`/`REVOKED`; a fresh `INIT`
  grant pays nothing.
- **Revocation abuse.** `revoke()` is grantor-only, revocable-only, and reverts
  once fully vested. It freezes the cap at the amount vested *at revoke time*, so
  the beneficiary keeps exactly what they had earned and nothing further accrues -
  while the grantor recovers only the genuinely-unvested remainder.
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
  configured tick; surplus/other ticks are not recoverable.
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
