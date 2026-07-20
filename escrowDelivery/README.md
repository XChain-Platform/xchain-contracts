# escrowDelivery: escrow that releases itself on a delivery attestation

A fork of the `escrow` template that adds one more settlement path: point it
at a carrier tracking URL, and if the settled page's body contains a
configured marker (e.g. `"status":"delivered"`), the escrow pays the seller
automatically - no buyer, seller, or arbiter has to call `release()`.

Read `escrow` first for the custody model. This README only covers what's
new.

## Why this needs the attestation framework

A contract cannot fetch a URL directly - the VM sandbox strips `fetch`,
`Date`, timers, and everything else non-deterministic so every validator
computes the same result. The contract instead *asks the network* to read
the tracking page for it, the same round trip the `urlOracle` template
demonstrates in isolation:

1. `requestDelivery(trackingUrl)` emits an `ATTEST` `http_get` request and
   remembers its deterministic `request_id`.
2. Off-chain, N attestation providers GET the URL, sign the body, and the
   indexer anchors the agreed response on-chain.
3. `onDelivery(request_id)` - the indexer's callback - reads the settled
   body. If it contains `deliveryMarker`, the contract's **entire** held
   balance pays the seller and the escrow goes terminal. Otherwise nothing
   happens except `pending` clearing so the check can be retried later.

## Lifecycle

| Method | Who | Effect |
|---|---|---|
| `initialize(buyer, seller, arbiter, tick, amount, deadlineBlocks, deliveryMarker)` | deployer | Sets immutable terms; status → `INIT`. |
| `fund()` | buyer (BATCHed after DEPOSIT) | Same as `escrow`: verifies the on-chain balance, arms the reclaim deadline; status → `FUNDED`. |
| `requestDelivery(trackingUrl)` | anyone | Emits an `http_get` attestation request (`redundancy: 3`, `deadlineBlocks: 20`) against `trackingUrl`; reverts if one is already pending. |
| `onDelivery(request_id)` | indexer callback | If the settled body contains `deliveryMarker`: pays the seller, status → `DELIVERED`. Otherwise: no-op, `pending` clears for a retry. |
| `release()` | buyer or arbiter | Manual fallback, same as `escrow`. |
| `refund()` | seller or arbiter | Manual fallback, same as `escrow`. |
| `timeout()` | buyer | After the deadline, if nothing settled. Same as `escrow`. |
| `status()` | anyone (read-only) | Current status string. |

**The manual paths never go away.** Automated delivery detection is a
convenience, not the only way to settle: a marker that stops matching
(carrier redesigns their tracking page, wrong marker configured) or a
genuine dispute still resolves through `release`/`refund`/`timeout`, exactly
as in plain `escrow`.

## Choosing a `deliveryMarker`

It's a plain substring match against the settled response body -
deliberately not JSON parsing, so this works against any carrier's tracking
page without coupling to one schema. Pick a marker that's stable and
specific: `"status":"delivered"` for a JSON API, or a fixed phrase like
`Delivered` for an HTML tracking page. Prefer an API endpoint over a
JS-rendered HTML page - the attestation provider does a plain GET, no
browser execution.

## Using it (SDK)

```js
// Deploy with terms (same params as escrow, plus deliveryMarker)
// DEPLOY|0|<deploy>|<gasLimit>|buyer|seller|arbiter|TEST|200|144|"status":"delivered"

// Fund atomically
await sdk.batch()
  .deposit({ contractActionIndex: idx, tick: 'TEST', quantity: 200 })
  .execute({ contractActionIndex: idx, method: 'fund' })
  .build();

// Once shipped, ask the network to check the tracking page.
await sdk.contracts.execute({
  contractActionIndex: idx, method: 'requestDelivery',
  params: ['https://carrier.example.com/track/1Z999']
});
// ...wait for the attestation to settle (or hit its deadline)...
// If it matched, onDelivery already paid the seller - check status():
await sdk.contracts.execute({ contractActionIndex: idx, method: 'status' });

// If the carrier's page never confirms, fall back to the manual paths.
await sdk.contracts.execute({ contractActionIndex: idx, method: 'release' });
```

## Attacks we considered

- **Stale-response replay.** `onDelivery` requires `request_id ===
  state.get('pending')` - the outstanding request, and only that one. A
  settled response for some earlier request cannot be replayed to force a
  release. (This fixes the gap the `urlOracle` template's README documents
  as a known limitation in its teaching example.)
- **A forged delivery body.** `onDelivery` reads the body from
  `xchain.attestation.getResponse(request_id)`, indexer-side consensus data;
  a caller cannot supply the payload. `redundancy: 3` requires 3 providers to
  agree before the response settles.
- **A malicious caller triggers a fake "delivered" release.** They can't:
  `requestDelivery` only *asks the network to check*; it cannot supply what
  the check finds. Only a genuinely-settled matching body pays out. Anyone
  being allowed to call `requestDelivery`/trigger the callback is safe by
  construction, the same way a permissionless liquidation call is safe -
  the caller is a messenger, not an authority.
- **Double payout / replay across paths.** Both `onDelivery`'s automated
  payout and the manual `release`/`refund`/`timeout` paths go through the
  same terminal-status guard: only a `FUNDED` escrow can settle, and the
  status flips before the transfer emits. A late `onDelivery` for a request
  that was outstanding when an arbiter manually resolved the dispute is a
  harmless no-op, not a double payout.
- **A stuck or never-settling check.** `deadlineBlocks: 20` on the
  attestation bounds the pending window. A non-matching or failed response
  clears `pending`, so `requestDelivery` can always be called again -
  automation never permanently blocks the manual paths, and `timeout()` is
  always there as a last resort.
- **Reentrancy.** Same as `escrow`: emissions are deferred and applied by
  the indexer after the method returns, inside one atomic scope.
- **Rounding / float drift.** Same as `escrow`: all comparisons use
  `xchain.math` bignumber ops.

## Known limitations (by design, for a teaching baseline)

- **Substring match, not schema validation.** A marker that happens to
  appear in an unrelated context (e.g. a status history table showing
  `"status":"delivered"` for a *previous, returned* shipment on the same
  page) would false-positive. Point at an endpoint scoped to one shipment,
  or fork this to parse a specific JSON field instead of a raw substring.
- **Single tick, sweep-the-whole-balance settlement.** Same limitations as
  `escrow`: only the configured tick is recoverable, and settlement always
  sweeps the entire held balance.
- **Arbiter is trusted**, same as `escrow`.

## Tests

`escrowDelivery.test.js` runs the real template through the VM (Node 22 /
isolated-vm):

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/escrowDelivery/escrowDelivery.test.js
```

## License

MIT - fork it, ship it, change it. (The XChain *platform* is AGPL-3.0; these
*templates* are deliberately permissive so you can build proprietary
contracts on top.)
