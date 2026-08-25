# Escrow

A buyer locks tokens for a seller. The funds release to the seller, or refund to
the buyer, only on an authorized instruction - with an arbiter to settle disputes
and a deadline so the buyer can never be locked out forever.

This is the simplest real-money contract in the library and the best place to
learn XChain's custody model. Read it before the crowdsale and AMM templates.

## The custody model (the one thing to understand first)

XChain has **no `msg.value`** - a contract call does not carry tokens. Instead:

- A contract is an address (`C:<CHAIN>:<index>`) that holds balances like a wallet.
- Tokens enter a contract through a separate **`DEPOSIT`** action to that address.
- Logic runs through an **`EXECUTE`** action.

To fund and act in one atomic step, submit both in a single **`BATCH`**:

```
BATCH( DEPOSIT(escrow, TICK, 200), EXECUTE(escrow, "fund") )
```

Batched sub-actions apply in order, and the deposit is persisted before the
`EXECUTE` runs - so `fund()` sees the deposited balance. The contract **never
trusts a caller-supplied amount**; it reads its own balance with
`xchain.getBalance(xchain.getContractAddress(), tick)`. That single habit is what
makes custody contracts safe on XChain.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(buyer, seller, arbiter, tick, amount, deadlineBlocks)` | deployer | Sets immutable terms; status → `INIT`. |
| `fund()` | anyone (usually buyer, BATCHed after DEPOSIT) | Verifies the contract holds ≥ `amount` of `tick`; anchors the reclaim deadline (`deadlineBlocks` from **this** block); status → `FUNDED`. |
| `release()` | buyer **or** arbiter | Sends the held balance to the seller; status → `RELEASED`. |
| `refund()` | seller **or** arbiter | Sends the held balance to the buyer; status → `REFUNDED`. |
| `timeout()` | buyer | After the deadline, buyer reclaims; status → `REFUNDED`. |
| `status()` | anyone (read-only) | Returns the current status string. |

Settlement sends the contract's **entire** balance of the escrowed tick, so no
dust is ever stranded.

## Using it (SDK)

```js
// Deploy with terms
const deploy = sdk.contracts.encode(escrowSource); // hex for the DEPLOY payload
// ... submit DEPLOY|0|<deploy>|<gasLimit>|buyer|seller|arbiter|TEST|200|144

// Fund atomically
await sdk.batch()
  .deposit({ contractActionIndex: escrowIndex, tick: 'TEST', quantity: 200 })
  .execute({ contractActionIndex: escrowIndex, method: 'fund' })
  .build();

// Later: release (buyer) - or refund (seller) - or timeout (buyer, after deadline)
await sdk.contracts.execute({ contractActionIndex: escrowIndex, method: 'release' });
```

## Attacks we considered

- **Caller lies about the deposit.** `fund()` ignores any amount in the call and
  reads the on-chain balance via `getBalance(self, tick)`. An underfunded escrow
  cannot be armed.
- **Unauthorized settlement.** `release`/`refund`/`timeout` check
  `getSourceAddress()` against the stored roles. A stranger - or the wrong party
  (seller calling `release`, buyer calling `refund`) - is rejected.
- **Double payout / replay.** Every settlement path requires `status === FUNDED`
  and sets a terminal status (`RELEASED`/`REFUNDED`) in the same execution. The
  state write commits atomically with the emitted `SEND`, so a second EXECUTE sees
  the terminal status and reverts. The status guard also blocks `fund()` from
  re-arming a settled escrow.
- **Settle before funding.** All settlement requires `FUNDED`; a fresh `INIT`
  escrow cannot pay out.
- **Buyer locked out by a stalling seller/arbiter.** `timeout()` lets the buyer
  reclaim after `deadlineBlocks`. Before the deadline it reverts.
- **Delayed funding arms an instantly-reclaimable escrow.** The reclaim clock
  starts in `fund()`, when custody is actually taken - not at deploy. If it were
  deploy-anchored, a contract deployed during negotiation and funded later would
  hand the seller a shrunken (or already-expired) protection window, letting the
  buyer `timeout()`-reclaim a just-funded escrow and bypass the seller/arbiter
  settlement path. Same clock-starts-at-funding pattern as the vesting template.
- **A deadline that is not the one the deployer wrote.** `initialize(...)`
  requires `deadlineBlocks` to be a canonical base-10 integer string in
  `[1, 1000000]` blocks. That is a shape check, not a value parse: a radix-less
  `parseInt` silently re-measures `'1e9'` as `1` and `'0x10'` as `16`, so a
  seller reading a ~19,000-year protection window off the DEPLOY action would
  have got a 1-block one, letting the buyer `fund()`, take delivery, and reclaim
  the whole balance via `timeout()` at the next block.
- **Reentrancy.** Emissions are deferred and processed by the indexer after the
  method returns, inside one atomic scope - there is no mid-method callback into
  this contract, and the terminal status is already written.
- **Rounding / float drift.** All amount comparisons use `xchain.math` bignumber
  ops; there are no float literals (the SDK validator confirms this).

## Known limitations (by design, for a teaching baseline)

- **Single tick.** The escrow handles exactly the configured tick. Tokens of any
  *other* tick sent to the contract address are **not recoverable** by this
  template - only ever deposit the configured tick.
- **Overfunding goes to the payee.** Because settlement sweeps the full held
  balance, depositing more than `amount` simply pays the extra to whoever the
  escrow settles to. Deposit the exact amount.
- **Arbiter is trusted.** A malicious arbiter can release or refund against one
  party's wishes. Choose a mutually-trusted arbiter, or fork this to require a
  buyer+seller co-signature for non-dispute settlement.

## Tests

`escrow.test.js` runs the real template through the VM (Node 22 / isolated-vm):

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/escrow/escrow.test.js
```

## License

MIT - fork it, ship it, change it. (The XChain *platform* is AGPL-3.0; these
*templates* are deliberately permissive so you can build proprietary contracts on
top.)
