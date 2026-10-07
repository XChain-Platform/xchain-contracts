# Crowdsale

A capped token sale with a soft cap, a deadline, and refunds. Buyers pay in one
token (`payTick`) and are promised a brand-new sale token (`saleTick`) at a fixed
`rate`. If the sale meets its soft cap it succeeds - buyers claim their tokens and
the owner withdraws the proceeds. If it misses the soft cap by the deadline it
fails - every buyer refunds in full.

This is the first template where **the contract creates and distributes a token**:
it `emit.issue`s and pre-mints the full sale supply into contract custody at deploy,
locks further minting, and `emit.send`s each buyer's allocation on claim. Pick a
`saleTick` name that isn't already taken - ticks are a global namespace, and the
deploy's constructor issue fails on a name collision.

## Custody model - note the footgun

There is no `msg.value`. Buyers pay by DEPOSITing `payTick` and EXECUTEing `buy()`
in one transaction:

```
BATCH( DEPOSIT(sale, PAY, amount), EXECUTE(sale, "buy") )
```

`buy()` attributes the payment to its caller by reading how much the contract's
`payTick` balance grew since the last accounted buy - which is only safe because
the DEPOSIT and `buy()` are in the **same transaction**. **Never DEPOSIT without
`buy()` in the same BATCH**: an un-bought deposit would be credited to the next
buyer who calls `buy()`. (This per-caller attribution is the pattern the AMM will
build on.)

A `BATCH` is **not** atomic, which is why that rule bites: its sub-actions settle
independently, so a `buy()` that reverts (`sale not open`, `sale closed (deadline
passed)`, `hard cap exceeded`) leaves the `DEPOSIT` ahead of it standing in the
contract, where the next buyer's delta absorbs it. Size the payment to clear.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(owner, payTick, saleTick, rate, softCap, hardCap, durationBlocks, saleDecimals)` | deployer | Issues and pre-mints the fixed sale-token inventory (`hardCap*rate`) into contract custody, locks minting, and opens the sale. |
| `buy()` | buyer (BATCHed after DEPOSIT) | Records the part of the caller's payment that buys whole sale-token units and returns the change in the same call (a payment worth less than one unit comes back in full); reverts past the deadline or hard cap. |
| `finalize()` | anyone | After the deadline (or once the hard cap is hit), sets `SUCCESS` if `raised >= softCap`, else `FAILED`. |
| `claim()` | buyer (SUCCESS) | Sends `contribution * rate` sale tokens from contract custody to the buyer. |
| `refund()` | buyer (FAILED) | Returns the buyer's full payment. |
| `withdraw()` | owner (SUCCESS, once) | Sends the raised proceeds to the owner. |
| `info()` | anyone (read-only) | `{ status, raised, softCap, hardCap, deadline }`. |

## Attacks we considered

- **Deposit misattribution.** Contributions are credited to the `buy()` caller via
  the balance delta - safe under a single `BATCH(DEPOSIT, buy)`. The footgun
  (orphan deposits, whether un-batched or left behind by a reverted `buy()`) is
  documented above; it is a usage rule, not a contract bug.
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
- **Token supply.** The full `hardCap*rate` supply is pre-minted into contract
  custody at issuance, with both `MINT` and later `MINT_SUPPLY` locked. Public
  `MINT` cannot consume the cap or create unbacked supply, and claims only send
  tokens from the fixed inventory.
- **Rounding.** `xchain.math` bignumber throughout; no float literals (SDK-validated).
  `claim()` floors `contribution * rate` onto the sale token's grid, so a
  payment off that grid would buy fewer tokens than it paid for, with the
  difference going to the owner at `withdraw()`. `buy()` therefore keeps only
  the smallest pay-tick amount that buys the same whole units, computed on the
  running total for top-ups, and sends the rest back to the buyer at once;
  every recorded contribution receives exactly its purchased tokens. It returns
  change rather than reverting because a reverted `buy()` would leave the whole
  deposit behind.

## Known limitations (teaching baseline)

- **Exact, single payTick.** Buyers must pay in the configured `payTick`, deposited
  in the same `BATCH` as `buy()`. Other-tick deposits are not recoverable.
- **Whole-payment caps.** A contribution whose accepted part would exceed the
  hard cap is rejected outright (only grid change is returned, never a partial
  fill of the cap). Buyers size their own deposits. Both
  caps compare exactly, not within a tolerance, so `raised` can never pass the
  hard cap by even one base unit and outrun the sale token's `maxSupply`.
- **Sub-base-unit overpay.** When `rate` times one pay-tick base unit does not
  land on the sale token's grid, the accepted amount can exceed the exact
  price by less than one pay-tick base unit per buyer, and that goes to the
  owner. For the same reason `raised` may never land exactly on the hard cap,
  in which case the sale runs to its deadline instead of closing early.
- **Owner trust.** The owner withdraws on success; buyers rely on the published
  terms (rate/caps/deadline), which are immutable after deploy.

## Tests

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/crowdsale/crowdsale.test.js
```

The E2E MockIndexer applies `SEND` against balances but treats `ISSUE` loosely.
The suite mirrors the production indexer's initial `mintSupply` custody credit,
then asserts token delivery and payment movements via resulting balances.

## License

MIT - fork it, ship it, change it.
