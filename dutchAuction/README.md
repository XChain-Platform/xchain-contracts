# Dutch Auction

A descending-price auction. A seller locks an item at a starting price that
falls linearly, block by block, to a floor - then holds there. There's no
bidding: the *first* buyer willing to pay the price in effect at their
transaction's block gets the item, at that price, right then.

Same custody model as `escrow`/`englishAuction`, but simpler in one respect:
because only ever one purchase can succeed, there are no losing bids to
refund - the entire sale settles in a single `buy()` call. It borrows the
vesting template's linear-curve-anchored-at-fund idiom, just running the curve
downward instead of up.

## The custody model (the one thing to understand first)

XChain has **no `msg.value`**. Tokens enter a contract only via a separate
**`DEPOSIT`**; logic runs via **`EXECUTE`**. Fund the item and attempt a
purchase the same way, atomically, with **`BATCH`**:

```
BATCH( DEPOSIT(auction, ITEM_TICK, 10),        EXECUTE(auction, "fund") )
BATCH( DEPOSIT(auction, BID_TICK, quotedPrice), EXECUTE(auction, "buy")  )
```

`buy()` **never trusts a caller-supplied amount**: it reads the contract's
actual `bidTick` balance and compares it to the asking price *in effect at the
block the transaction lands*. If the deposit exceeds that price (a quote can
go stale between when you read it and when your transaction confirms - the
price only ever moves in the buyer's favor while waiting), the excess is
refunded in the same call. If the deposit falls short, `buy()` reverts and the
deposit sits in the contract's custody until either a corrected `buy()` lands
or the seller `cancel()`s (which returns only the *item*, not stray `bidTick` -
see Known limitations).

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(seller, itemTick, itemAmount, bidTick, startPrice, endPrice, durationBlocks)` | deployer | Sets immutable terms (`startPrice > endPrice > 0`); status → `INIT`. |
| `fund()` | seller (BATCHed after DEPOSIT) | Verifies the contract holds ≥ `itemAmount` of `itemTick`; starts the price clock from **this** block; status → `ACTIVE`. |
| `buy()` | anyone (BATCHed after DEPOSIT) | Must deposit ≥ the current asking price; item → buyer, price → seller, any excess → buyer, all in one call; status → `SOLD`. |
| `cancel()` | seller, only before any purchase | Returns the item to the seller; status → `CANCELLED`. |
| `info()` | anyone (read-only) | `{ status, currentPrice, startPrice, endPrice }`. |

**Price curve:** `startPrice` at elapsed = 0, falling linearly to `endPrice` at
`durationBlocks` elapsed, then pinned at `endPrice` forever after. Time is
measured in blocks via `getBlockHeight()` (no wall-clock), same as `vesting`.

## Using it (SDK)

```js
// Deploy: 10 units of ITEM, price falls 1000 -> 100 TEST over 100 blocks
await sdk.contracts.deploy({
  source: dutchAuctionSource,
  params: [seller, 'ITEM', '10', 'TEST', '1000', '100', '100']
});

// Seller funds the item
await sdk.batch()
  .deposit({ contractActionIndex: auctionIndex, tick: 'ITEM', quantity: 10 })
  .execute({ contractActionIndex: auctionIndex, method: 'fund' })
  .build();

// Buyer reads info() for the current price, then buys at (at least) that price
await sdk.batch()
  .deposit({ contractActionIndex: auctionIndex, tick: 'TEST', quantity: currentPrice })
  .execute({ contractActionIndex: auctionIndex, method: 'buy' })
  .build();
```

## Attacks we considered

- **Caller lies about the deposit.** `buy()` reads the contract's own balance
  via `getBalance`, never a caller-supplied amount, and computes the required
  price itself from the block height - a caller cannot claim a lower price
  than the one actually in effect.
- **Stale-quote overcharge.** The price only ever *falls* while a transaction
  is in flight, so a buyer who read the price and submitted promptly can only
  ever end up *overpaying relative to a fresher, lower price* - and `buy()`
  refunds any amount above the price actually charged. It can never charge
  more than the quote the buyer paid against.
- **Double-sale.** `buy()` requires `status === ACTIVE` and sets `SOLD` before
  emitting; the state write commits atomically with the emissions, so a second
  `buy()` on an already-sold auction reverts - there is no reentrancy window
  (emissions are deferred and applied by the indexer after the method
  returns).
- **Rounding gifting free value.** The asking price is floored onto `bidTick`'s
  decimal grid (`floorToDecimals`) before it's used as both the required
  minimum and the emitted amounts, so the indexer's own half-up
  re-normalization (its bcmath is half-up, not banker's/half-even) can never
  round the seller's payout - or the required
  minimum - up past what was actually deposited.
- **Unauthorized fund/cancel.** Both require `getSourceAddress() === seller`.
- **Delayed funding shrinking the price schedule.** Same pattern as `vesting`
  and `englishAuction`: the price clock is anchored in `fund()`, not
  `initialize()`, so every auction runs its full advertised curve from the
  block the item actually lands in custody.
- **Rounding / float drift.** All amount comparisons use `xchain.math`
  bignumber ops; the SDK's syntax validator rejects float literals outright.

## Known limitations (by design, for a teaching baseline)

- **An underpaying `buy()` strands the deposit.** If a buyer deposits less
  than the current price, `buy()` reverts (correctly - no sale happens), but
  the deposit itself is not auto-refunded; it sits in the contract's `bidTick`
  custody until a follow-up correct `buy()` covers (and thus consumes) it, or
  forever if the auction is later cancelled (`cancel()` only ever returns the
  *item*). Always deposit at least the price you read from `info()` in the
  same transaction.
- **Single item tick, single bid tick.** Only the configured `itemTick` and
  `bidTick` are handled; tokens of any other tick sent to the contract address
  are not recoverable by this template.
- **No reserve beyond `endPrice`.** The price never falls below `endPrice` and
  never expires into an unsellable state - it's a genuine floor, not a
  "cancel if unsold by X" deadline. Use `cancel()` if the seller wants out.

## Tests

`dutchAuction.test.js` runs the real template through the VM (Node 22 /
isolated-vm):

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/dutchAuction/dutchAuction.test.js
```

## License

MIT - fork it, ship it, change it. (The XChain *platform* is AGPL-3.0; these
*templates* are deliberately permissive so you can build proprietary contracts
on top.)
