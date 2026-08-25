# English Auction

An ascending-bid auction. A seller locks an item; bidders compete, each new bid
must beat the last, and the moment a bid is topped its owner is refunded -
immediately, in the same transaction that topped it. After a deadline, anyone
can settle: the item goes to the winner and the winning bid goes to the seller.

This is the custody model applied to a *contest* instead of a single hand-off -
read `escrow` first if you haven't; this template reuses its funding pattern and
its deadline-anchored-at-fund idiom, and adds the crowdsale template's
delta-accounting trick to safely track a repeatedly-refilled balance.

## The custody model (the one thing to understand first)

XChain has **no `msg.value`**. Tokens enter a contract only via a separate
**`DEPOSIT`**; logic runs via **`EXECUTE`**. Fund the item and place bids the
same way, atomically, with **`BATCH`**:

```
BATCH( DEPOSIT(auction, ITEM_TICK, 10), EXECUTE(auction, "fund") )
BATCH( DEPOSIT(auction, BID_TICK, 80),  EXECUTE(auction, "bid")  )
```

The contract **never trusts a caller-supplied amount**. Because every out-bid
deposit is refunded within the same execution that supersedes it, the
contract's `bidTick` balance is always exactly the current high bid - so a new
bid's size is read as *the growth in that balance since the last bid*
(`held - highBid`), not a separately-passed parameter.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(seller, itemTick, itemAmount, bidTick, minBid, deadlineBlocks)` | deployer | Sets immutable terms; status → `INIT`. |
| `fund()` | seller (BATCHed after DEPOSIT) | Verifies the contract holds ≥ `itemAmount` of `itemTick`; anchors the bidding deadline from **this** block; status → `ACTIVE`. |
| `bid()` | anyone except the current leader (BATCHed after DEPOSIT) | Must exceed both `minBid` and the current high bid; refunds the previous leader in the same call. |
| `settle()` | anyone, after the deadline | Item → high bidder, winning bid → seller (status → `SOLD`); or item → seller if nobody bid (status → `UNSOLD`). |
| `cancel()` | seller, only before any bid | Returns the item to the seller; status → `CANCELLED`. |
| `info()` | anyone (read-only) | `{ status, highBid, highBidder, minBid, deadline }`. |

## Using it (SDK)

```js
// Deploy with terms: 10 units of ITEM, min bid 50 TEST, 144-block window
await sdk.contracts.deploy({
  source: englishAuctionSource,
  params: [seller, 'ITEM', '10', 'TEST', '50', '144']
});

// Seller funds the item
await sdk.batch()
  .deposit({ contractActionIndex: auctionIndex, tick: 'ITEM', quantity: 10 })
  .execute({ contractActionIndex: auctionIndex, method: 'fund' })
  .build();

// Bidder places a bid
await sdk.batch()
  .deposit({ contractActionIndex: auctionIndex, tick: 'TEST', quantity: 80 })
  .execute({ contractActionIndex: auctionIndex, method: 'bid' })
  .build();

// After the deadline, anyone settles
await sdk.contracts.execute({ contractActionIndex: auctionIndex, method: 'settle' });
```

## Attacks we considered

- **Caller lies about the deposit.** `fund()` and `bid()` both read the
  contract's own balance via `getBalance`, never a caller-supplied amount.
- **Bid that doesn't actually beat the leader.** `bid()` requires the deposit
  delta to strictly exceed both `minBid` and the current `highBid`.
- **Front-run/underbid griefing.** Every bid that gets superseded is refunded
  in the *same* execution that supersedes it - a bidder is never at risk of
  their funds sitting locked behind a later, unrelated bid.
- **Settling early.** `settle()` requires the deadline to have passed.
- **Double-settle / replay.** `settle()` requires `status === ACTIVE` and sets
  a terminal status (`SOLD`/`UNSOLD`) before emitting; the state write commits
  atomically with the emission, so a second `settle()` reverts.
- **Cancelling after a bid landed.** `cancel()` requires `highBidder` to be
  unset; once someone has bid, the seller can no longer unilaterally withdraw
  the item - it must go through `settle()`.
- **Unauthorized fund/cancel.** Both require `getSourceAddress() === seller`.
- **Delayed funding shrinking the bidding window.** Same pattern as `escrow`
  and `vesting`: the deadline is anchored in `fund()`, not `initialize()`, so
  every auction gets its full window from the block the item actually lands in
  custody.
- **Reentrancy.** Emissions are deferred and applied by the indexer after the
  method returns, inside one atomic scope - there is no mid-method callback
  into this contract.
- **Rounding / float drift.** All amount comparisons use `xchain.math`
  bignumber ops; the SDK's syntax validator rejects float literals outright.
- **A rejected bid's DEPOSIT is not rolled back.** BATCH sub-actions are not
  all-or-nothing, so when `bid()` reverts - auction not `ACTIVE`, past the
  deadline, below `minBid`, not exceeding the current high bid, or a self-raise
  by the current leader - the DEPOSIT batched ahead of it has already settled
  and stays in the contract's `bidTick` custody. It is **not recoverable by its
  sender**: the delta-accounting folds it into the *next* successful bidder's
  credited bid, and from there it reaches the seller at `settle()`. Same footgun
  the `cardDispenser` and `dutchAuction` templates document. Read `info()` and
  be sure the bid will clear before batching the DEPOSIT behind it.

## Known limitations (by design, for a teaching baseline)

- **A leader cannot raise their own bid.** `bid()` rejects a bid from the
  current `highBidder`. This is deliberate: the delta-accounting only ever
  measures balance growth *since the last bid*, not a running total per
  bidder, so a self-raise would refund-then-replace the leader's existing
  stake with just the marginal top-up, silently shrinking their real bid. If
  you need self-raises, track a per-bidder cumulative stake in state instead
  of relying on the shared-balance delta. **The cost of that choice:** a leader
  who tries anyway loses the top-up, because the self-raise reverts while its
  batched DEPOSIT does not (see "A rejected bid's DEPOSIT is not rolled back"
  above). Raise from a fresh address, or fork this template with per-bidder
  stakes before running an auction where that mistake is likely.
- **Single item tick, single bid tick.** Only the configured `itemTick` and
  `bidTick` are handled; tokens of any other tick sent to the contract address
  are not recoverable by this template.
- **No reserve price beyond `minBid`.** There is no "no sale unless X" floor
  distinct from the minimum bid - if you need one, treat `minBid` as the
  reserve.
- **No bid increment schedule.** Any bid that clears `minBid` and exceeds the
  current high bid is accepted, however small the margin.

## Tests

`englishAuction.test.js` runs the real template through the VM (Node 22 /
isolated-vm):

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/englishAuction/englishAuction.test.js
```

## License

MIT - fork it, ship it, change it. (The XChain *platform* is AGPL-3.0; these
*templates* are deliberately permissive so you can build proprietary contracts
on top.)
