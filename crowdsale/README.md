# Crowdsale

A capped token sale with a soft cap, a deadline, and refunds. Buyers pay in one
token (`payTick`) and are promised a brand-new sale token (`saleTick`) at a fixed
`rate`. If the sale meets its soft cap it succeeds - buyers claim their tokens and
the owner withdraws the proceeds. If it misses the soft cap by the deadline it
fails - every buyer refunds in full.

This is the first template where **the contract creates and distributes a token**:
it `emit.issue`s the sale token at deploy (becoming its owner) and `emit.mint`s to
each buyer on claim. Pick a `saleTick` name that isn't already taken - ticks are a
global namespace, and the deploy's constructor issue fails on a name collision.

## Custody model - note the footgun

There is no `msg.value`. Buyers pay by DEPOSITing `payTick` and EXECUTEing `buy()`
atomically:

```
BATCH( DEPOSIT(sale, PAY, amount), EXECUTE(sale, "buy") )
```

`buy()` attributes the payment to its caller by reading how much the contract's
`payTick` balance grew since the last accounted buy - which is only safe because
the DEPOSIT and `buy()` are in the **same transaction**. **Never DEPOSIT without
`buy()` in the same BATCH**: an un-bought deposit would be credited to the next
buyer who calls `buy()`. (This per-caller attribution is the pattern the AMM will
build on.)

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(owner, payTick, saleTick, rate, softCap, hardCap, durationBlocks, saleDecimals)` | deployer | Issues the sale token (max supply `hardCap*rate`, contract-owned); opens the sale. |
| `buy()` | buyer (BATCHed after DEPOSIT) | Records the caller's contribution; reverts past the deadline or hard cap. |
| `finalize()` | anyone | After the deadline (or once the hard cap is hit), sets `SUCCESS` if `raised >= softCap`, else `FAILED`. |
| `claim()` | buyer (SUCCESS) | Mints `contribution * rate` sale tokens to the buyer. |
| `refund()` | buyer (FAILED) | Returns the buyer's full payment. |
| `withdraw()` | owner (SUCCESS, once) | Sends the raised proceeds to the owner. |
| `info()` | anyone (read-only) | `{ status, raised, softCap, hardCap, deadline }`. |

## Attacks we considered

- **Deposit misattribution.** Contributions are credited to the `buy()` caller via
  the balance delta - safe under atomic `BATCH(DEPOSIT, buy)`. The footgun (orphan
  deposits) is documented above; it is a usage rule, not a contract bug.
- **Buying after close.** `buy()` reverts past the deadline and rejects any
  contribution that would push `raised` over the hard cap.
- **Premature finalize.** `finalize()` requires either the deadline or the hard
  cap; it can't be called early to lock a favorable/unfavorable outcome.
- **Double claim / double refund.** Each deletes the caller's contribution record
  before emitting, so a second call finds nothing.
- **Claim on a failed sale / refund on a success.** Status-gated - `claim()` is
  SUCCESS-only, `refund()` is FAILED-only.
- **Unauthorized or repeated withdrawal.** `withdraw()` is owner-only and guarded
  by a `withdrawn` flag.
- **Token supply.** The sale token is issued with `maxSupply = maxMint =
  hardCap*rate`, so total mintable can never exceed what the sale could sell.
- **Rounding.** `xchain.math` bignumber throughout; no float literals (SDK-validated).

## Known limitations (teaching baseline)

- **Exact, single payTick.** Buyers must pay in the configured `payTick`, deposited
  atomically with `buy()`. Other-tick deposits are not recoverable.
- **Whole-payment caps.** A contribution that would exceed the hard cap is rejected
  outright (no partial accept + change). Buyers size their own deposits.
- **Owner trust.** The owner withdraws on success; buyers rely on the published
  terms (rate/caps/deadline), which are immutable after deploy.

## Tests

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/crowdsale/crowdsale.test.js
```

The E2E MockIndexer applies `SEND` against balances but treats `MINT`/`ISSUE`
loosely, so token delivery is asserted via the emitted `MINT` action and payment
movements via resulting balances.

## License

MIT - fork it, ship it, change it.
