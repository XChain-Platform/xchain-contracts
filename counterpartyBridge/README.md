# counterpartyBridge: migrate Counterparty holders to an XChain tick

A one-time migration bridge for holders of a single [Counterparty](https://counterparty.io/)
asset. A holder proves their Counterparty balance and mints the equivalent
amount of a brand-new XChain tick to the same address.

Counterparty rides on top of Bitcoin: its balances are computed by
Counterparty nodes from OP_RETURN/bare-multisig data embedded in ordinary
Bitcoin transactions. That means a Counterparty balance is **not** something
the VM sandbox can see directly, and even if it could, no two validators
would necessarily agree on a third-party Counterparty indexer's *current*
interpretation of the chain. So this bridge reuses the exact off-chain
attestation pattern documented in `urlOracle`: it asks the network to fetch
[tokenscan.io's public REST API](https://tokenscan.io/api#balances) and
anchors the agreed response on-chain before trusting it.

**API used:** `GET https://cp20.tokenscan.io/api/balances/{address}/{page}/{limit}`
returns a wallet's *entire* Counterparty holdings as an array (tokenscan has
no single-address+single-asset endpoint):

```json
{
    "address": "1Donatet2LrNpuWByAnH8gc9Wh9zSzZuLC",
    "data": [
        { "asset": "PEPECASH", "asset_longname": "", "description": "...",
          "estimated_value": { "btc": "...", "usd": "...", "xcp": "..." },
          "quantity": "650000.00000000" },
        ...
    ],
    "total": 6
}
```

`requestClaim()` calls this at `/1/500` (page 1, limit 500) and `onClaim`
scans `data` for the row whose `asset` matches the deployed `cpAsset`;
`quantity` is already a normalized decimal string (no separate raw-integer
field to divide by divisibility, unlike Counterparty's own core API).

```
1. requestClaim()            -> caller asks the network to check THEIR OWN
                                 Counterparty balance of `cpAsset`. Emits an
                                 ATTEST http_get request, remembers its
                                 request_id.
2. (off-chain)                  N attestation providers GET the balances API,
                                 sign the body, the indexer anchors the
                                 agreed response on-chain.
3. onClaim(request_id, address) -> the indexer calls this back. A positive
                                 settled balance MINTS that exact amount of
                                 `xchainTick` to `address` and marks it
                                 claimed, permanently.
```

Because a Counterparty holder's Bitcoin address **is** their XChain address
on that chain (XChain transactions are themselves Bitcoin/Dogecoin/Litecoin
transactions), the claim needs no separate registration step: the address
that asks for the check is the address the minted tokens land on. Nobody can
trigger a check on someone else's behalf that then mints to a third party.

## Methods

| Method | Who | Effect |
|---|---|---|
| `requestClaim()` | anyone (self-serve) | Emits an `http_get` attestation request for the caller's own `cpAsset` balance (`redundancy: 3`, `deadlineBlocks: 20`); reverts if the caller already claimed or already has a check pending. |
| `onClaim(request_id, address)` | indexer callback | Reads the settled response. A positive balance mints `min(balance, remaining cap)`-quantised tokens to `address` and marks it claimed. A zero balance, malformed body, or failed attestation is a no-op (pending clears, retry later) - not a revert. |
| `claimed(address)` | anyone | Read-only: how much `address` has already claimed (`'0'` if none). |
| `info()` | anyone | `{ cpAsset, xchainTick, decimals, maxSupply, totalClaimed }`. |

## Usage

```
EXECUTE(bridge, "requestClaim")
# ...wait for the attestation to settle (or hit its deadline)...
EXECUTE(bridge, "onClaim", "<request_id>", "<your_address>")   # usually relayed automatically
EXECUTE(bridge, "claimed", "<your_address>")                   # verify
```

## Deploy

`initialize(cpAsset, xchainTick, maxSupply, decimals)`

- `cpAsset`: the Counterparty asset name (e.g. `XCPCARD`).
- `xchainTick`: the new XChain tick to issue (must be globally unused; a
  collision reverts the `DEPLOY`).
- `maxSupply`: hard cap, in `xchainTick` units. **Set this to `cpAsset`'s
  known total supply** so the bridge can never mint more XChain-side than
  exists Counterparty-side no matter how many addresses claim.
- `decimals`: must match how the balances API reports
  `quantity_normalized` for this asset (8 for a divisible Counterparty
  asset, 0 for an indivisible one) so claimed amounts land on the tick's
  real grid.

One deploy bridges **one** Counterparty asset to **one** XChain tick. To
bridge multiple assets, deploy one instance per asset.

## Attacks we considered

- **Non-determinism via direct API access.** Impossible by construction:
  the sandbox strips every I/O primitive. The attestation framework is the
  only door, and what comes through it is consensus-finalized (N providers
  agreed byte-for-byte on the response).
- **Claiming on someone else's behalf to steal their tokens.** Not
  possible: `requestClaim()` always checks `getSourceAddress()`'s own
  balance, and `onClaim` mints to that same address. There is no
  caller-suppliable destination.
- **Stale-response replay.** `onClaim` requires `request_id ===
  state.get('pending:' + address)`, pinned per address (not the
  unpinned `urlOracle` teaching-example gap). A settled response for an
  old or different address's request cannot be replayed.
- **Double-claim.** `requestClaim()` reverts if `claimed:<address>` is
  already set; `onClaim` also short-circuits to a no-op if a race lets two
  settled callbacks reach it (defense in depth - the pending-pin check
  should already prevent this).
- **Forged balance.** `onClaim` reads the balance from
  `xchain.attestation.getResponse(request_id)`, indexer-side consensus
  state; a caller cannot supply the payload directly.
- **Minting past the Counterparty-side supply.** `maxSupply` (set at
  deploy from `cpAsset`'s real total supply) hard-caps `emit.issue`, and
  `onClaim` also checks `totalClaimed + amount <= maxSupply` itself with a
  clear revert message before minting, rather than relying on the
  indexer's cap enforcement to reject (and roll back) the whole claim.
- **Rounding a mint above the cap.** Claimed amounts are floored onto
  `xchainTick`'s decimal grid before minting (same footgun and fix as
  `crowdsale.claim()`): the indexer re-normalises every emitted quantity to
  the tick's decimals with half-even rounding, which can round UP and trip
  the cap on an otherwise-honest claim.
- **A malformed or schema-drifted API body.** `onClaim` never throws on a
  parse failure; it treats an unparseable or field-missing body the same
  as "no balance found" (no-op, retryable), not a crash that could strand
  gas or corrupt state.

## Known limitations (this is a teaching example)

- **One-time snapshot, not a live peg.** A claim reflects the balance at
  the moment `onClaim` settles. It is not re-checked afterward; sending
  more of `cpAsset` to the same address after claiming does not entitle it
  to claim again (by design - this is a migration tool, not an ongoing
  1:1 bridge). A production fork wanting a live peg would need a
  lock/burn-and-mint scheme instead of a pure snapshot mint.
- **Trusts tokenscan.io's current answer.** Like any attestation-based
  oracle, this is only as good as the queried endpoint. A single
  compromised or lying tokenscan instance under `redundancy: 1` could
  under- or over-report a balance; this template uses `redundancy: 3` so
  three independent providers' GETs must byte-match before `onClaim`
  trusts the body. This template hardcodes `cp20.tokenscan.io`
  (Counterparty 2.0 mainnet); a production fork should make the host and
  redundancy configurable per deploy, and should confirm which
  Counterparty network/host tokenscan's `cp20` prefix actually serves
  before pointing real value at it.
- **Page 1 / limit 500 only.** `requestClaim()` requests
  `/api/balances/{address}/1/500`. A wallet holding 500+ *distinct*
  Counterparty assets could have `cpAsset` fall past this page and the
  claim would settle as "no balance found" even though the holder does
  own it. Fine for realistic migration wallets; a production fork
  targeting exotic mega-wallets should paginate through `total` instead
  of assuming one page suffices.
- **No burn/lock on the Counterparty side.** This mints a *new*, separate
  XChain-side token; it does not lock, burn, or otherwise account for the
  original Counterparty asset. A holder who claims and then sells their
  Counterparty asset to someone else ends up with the migrated tokens
  *and* the sale proceeds - a genuine double-spend of *value* across the
  two systems, which no attestation-only design can prevent (the origin
  chain isn't the one being modified). This is acceptable for a
  once-off "snapshot migration to a new home" campaign announced in
  advance, not for a bridge meant to stay open indefinitely as a fungible
  peg.
- **Body schema confirmed from tokenscan.io's published docs, not yet
  exercised against a live GET.** `extractAssetQuantity()` matches the
  shape documented at https://tokenscan.io/api#balances (verified
  2026-08-06), but this template has not yet run an e2e attestation
  against the real endpoint - a live check before migrating mainnet
  holders is still warranted in case the documented shape has drifted.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/counterpartyBridge/counterpartyBridge.test.js
```

Requires Node 22 (`isolated-vm`).

## License

MIT, like every template in this library.
