# counterpartyBridge: burn-to-mint a Counterparty asset into an XChain tick

A genuinely 1:1 bridge for holders of a single [Counterparty](https://counterparty.io/)
asset. A holder sends (burns) their Counterparty asset to a well-known,
unspendable Counterparty address, and once that burn confirms, mints the
same amount of a brand-new XChain tick to the same address.

Counterparty rides on top of Bitcoin: its state is computed by Counterparty
nodes from OP_RETURN/bare-multisig data embedded in ordinary Bitcoin
transactions. That means neither a Counterparty balance nor a Counterparty
transaction is something the VM sandbox can see directly, and even if it
could, no two validators would necessarily agree on a third-party
Counterparty indexer's *current* interpretation of the chain. So this
bridge reuses the exact off-chain attestation pattern documented in
`urlOracle`: it asks the network to fetch
[tokenscan.io's public REST API](https://tokenscan.io/api#sends) and
anchors the agreed response on-chain before trusting it.

**Why burn-to-mint, not a balance snapshot.** An earlier version of this
template minted against a holder's *current* Counterparty balance. That is
not a real bridge: nothing stops a holder from claiming on XChain and then
separately selling the original asset to someone else on Counterparty,
walking away with both the migrated tokens and the sale proceeds - a
genuine double-spend of value across the two systems. Gating the mint on an
irreversible burn closes that hole: once the asset is sent to an address
nobody holds the key to, it cannot also be sold.

**API used:** `GET https://cp20.tokenscan.io/api/sends/{destination}/{page}/{limit}`
returns every Counterparty "Send" transaction ever recorded landing on
`{destination}`, across every asset and every sender (tokenscan has no
source+asset-filtered endpoint):

```json
{
    "data": [
        { "asset": "PEPECASH", "asset_longname": "", "block_index": 466690,
          "destination": "1BitcoinEaterAddressDontSendf59kuE",
          "quantity": "44000.00000000",
          "source": "1PNkBxnz5ePW8FeK6CSs8V2fGHcN9B6HNk",
          "status": "valid", "timestamp": 1492254524,
          "tx_hash": "6461c15f...80fd81287", "tx_index": 922735 },
        ...
    ],
    "total": 7809
}
```

`requestClaim()` calls this at `/1/15` (page 1, limit **15**, most recent
first) against `BURN_ADDRESS`; `onClaim` scans `data` for rows whose
`source` is the claiming address, whose `asset` matches the deployed
`cpAsset`, and whose `status` is `valid`, sums every one whose `tx_hash`
has not already been credited, and mints the total in one shot.
`quantity` is already a normalized decimal string (no separate
raw-integer field to divide by divisibility).

**Why only 15, not tokenscan's own page-size ceiling.** This is not a
generous-headroom choice - confirmed on a real e2e run against the live
endpoint (2026-08-08): the indexer's on-chain attestation-response payload
cap is a hard **8192 bytes** of combined ACTION data, and each row of this
feed runs roughly 200-250 bytes. A page of 500 rows compiled to ~20KB and
was rejected outright by the encoder (`Combined compiled payload (20433
bytes) exceeds maximum (8192)`) before the transaction could even be
built. 15 rows leaves comfortable headroom under the cap; see "Known
limitations" for what a shallow page costs once burn volume on the shared
address grows.

```
1. requestClaim()            -> caller asks the network to list every Send
                                 that has ever landed on BURN_ADDRESS. Emits
                                 an ATTEST http_get request, remembers its
                                 request_id.
2. (off-chain)                  N attestation providers GET the sends API,
                                 sign the body, the indexer anchors the
                                 agreed response on-chain.
3. onClaim(request_id, address) -> the indexer calls this back. Every
                                 settled burn from `address` of `cpAsset`
                                 not already credited is summed and MINTS
                                 that total of `xchainTick` to `address`;
                                 each burn's tx_hash is then marked
                                 credited, permanently, individually.
```

Because a Counterparty holder's Bitcoin address **is** their XChain address
on that chain (XChain transactions are themselves Bitcoin/Dogecoin/Litecoin
transactions), the claim needs no separate registration step: the address
that burned the asset is the address the minted tokens land on. Nobody can
trigger a check on someone else's behalf that then mints to a third party.

## Methods

| Method | Who | Effect |
|---|---|---|
| `requestClaim()` | anyone (self-serve) | Emits an `http_get` attestation request listing every Send on `BURN_ADDRESS` (`redundancy: 3`, `deadlineBlocks: 20`); reverts if the caller already has a check pending. Callable again later, once new burns exist. |
| `onClaim(request_id, address)` | indexer callback | Reads the settled response. Sums every not-yet-credited burn of `cpAsset` sent by `address`, quantises it onto the tick's decimal grid, and mints the total. Zero new burns, a malformed body, or a failed attestation is a no-op (pending clears, retry later) - not a revert. |
| `claimedTotal(address)` | anyone | Read-only: how much `address` has been credited in total so far (`'0'` if none). |
| `burned(tx_hash)` | anyone | Read-only: whether a specific Counterparty burn transaction has already been credited. |
| `info()` | anyone | `{ cpAsset, xchainTick, decimals, maxSupply, totalClaimed, burnAddress }`. |

## Usage

```
# On Counterparty: SEND cpAsset to 1BitcoinEaterAddressDontSendf59kuE from your holding address.
# ...wait for that Bitcoin transaction to confirm...
EXECUTE(bridge, "requestClaim")
# ...wait for the attestation to settle (or hit its deadline)...
EXECUTE(bridge, "onClaim", "<request_id>", "<your_address>")   # usually relayed automatically
EXECUTE(bridge, "claimedTotal", "<your_address>")               # verify
```

## Deploy

`initialize(cpAsset, xchainTick, maxSupply, decimals)`

- `cpAsset`: the Counterparty asset name (e.g. `XCPCARD`).
- `xchainTick`: the new XChain tick to issue (must be globally unused; a
  collision reverts the `DEPLOY`).
- `maxSupply`: hard cap, in `xchainTick` units. **Set this to `cpAsset`'s
  known total supply** so the bridge can never mint more XChain-side than
  exists Counterparty-side no matter how many addresses burn-and-claim.
- `decimals`: must match how the sends API reports `quantity` for this
  asset (8 for a divisible Counterparty asset, 0 for an indivisible one)
  so claimed amounts land on the tick's real grid.

The burn destination (`BURN_ADDRESS`, `1BitcoinEaterAddressDontSendf59kuE`)
is hardcoded, not a deploy param - see "Known limitations" below for the
tradeoff this makes.

One deploy bridges **one** Counterparty asset to **one** XChain tick. To
bridge multiple assets, deploy one instance per asset.

## Attacks we considered

- **Non-determinism via direct API access.** Impossible by construction:
  the sandbox strips every I/O primitive. The attestation framework is the
  only door, and what comes through it is consensus-finalized (N providers
  agreed byte-for-byte on the response).
- **Claiming on someone else's behalf to steal their tokens.** Not
  possible: `requestClaim()` always scans `getSourceAddress()`'s own burns,
  and `onClaim` mints to that same address. There is no caller-suppliable
  destination.
- **Stale-response replay.** `onClaim` requires `request_id ===
  state.get('pending:' + address)`, pinned per address (not the
  unpinned `urlOracle` teaching-example gap). A settled response for an
  old or different address's request cannot be replayed.
- **Double-crediting the same burn.** Each Counterparty `tx_hash` is
  nullified individually (`burned:<tx_hash>`) the moment it is credited,
  BEFORE the mint is emitted. A burn reported again in a later
  `requestClaim()` round, or replayed via a stale settled response, is
  silently skipped rather than minted again.
- **Forged burn.** `onClaim` reads the burn list from
  `xchain.attestation.getResponse(request_id)`, indexer-side consensus
  state; a caller cannot supply the payload directly.
- **Claiming and also keeping/selling the original asset ("double
  value").** This is the reason the design is burn-to-mint rather than a
  balance snapshot: the mint is gated on a Send to an address nobody holds
  the key to, which is irreversible the moment it confirms on
  Counterparty. See "Why burn-to-mint" above.
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
  as "no burns found" (no-op, retryable), not a crash that could strand
  gas or corrupt state.

## Known limitations (this is a teaching example)

- **`BURN_ADDRESS` is a shared, industry-wide address, not exclusive to
  this bridge - and the on-chain payload cap means only the most recent
  ~15 sends to it are ever visible to `onClaim`.** `1BitcoinEaterAddressDontSendf59kuE`
  is a widely-used Bitcoin "eater" address with no known private key -
  many unrelated Counterparty projects burn to it too (confirmed live:
  dozens of unrelated assets show up in its send history, at a real
  volume that already forced the page size down from a hoped-for 500 to
  15 - see "API used" above). That has real consequences for a
  production fork: (1) a holder who does not `requestClaim()` promptly
  after burning risks their burn scrolling off the visible page as *other
  people's* unrelated burns land after it - this is not a hypothetical
  edge case here, it is the expected steady state; and (2) there is no
  cryptographic binding between "sent to this address" and "sent *for
  this bridge*" beyond matching `cpAsset`, which is sufficient today (the
  asset itself identifies intent) but does nothing to protect the paging
  window. A production fork expecting real volume should derive a
  bridge-specific, provably-unspendable burn address instead (e.g.
  hashing a fixed bridge-identifying string to an off-curve point) so its
  15-row window is scoped to its own traffic, not shared with every other
  project using the generic eater address - and/or have `onClaim` walk
  multiple pages across successive attestation rounds instead of trusting
  page 1 alone.
- **Trusts tokenscan.io's current answer.** Like any attestation-based
  oracle, this is only as good as the queried endpoint. A single
  compromised or lying tokenscan instance under `redundancy: 1` could
  under- or over-report burns; this template uses `redundancy: 3` so
  three independent providers' GETs must byte-match before `onClaim`
  trusts the body. This template hardcodes `cp20.tokenscan.io`
  (Counterparty 2.0 mainnet); a production fork should make the host and
  redundancy configurable per deploy, and should confirm which
  Counterparty network/host tokenscan's `cp20` prefix actually serves
  before pointing real value at it.
- **Burn is one-way and manual.** This template does not automate the
  Counterparty-side SEND; the holder must send `cpAsset` to `BURN_ADDRESS`
  themselves, on Counterparty, before calling `requestClaim()`. There is
  no way to un-burn a mistaken send (that is the entire point of the
  design), so a fork's UI should make the destination and asset very
  explicit before a holder signs that transaction.
- **Body schema confirmed from tokenscan.io's published docs AND a live
  GET.** `extractBurnSends()` matches the shape documented at
  https://tokenscan.io/api#sends and verified 2026-08-08 against a real
  `GET /api/sends/1BitcoinEaterAddressDontSendf59kuE/1/5` response, but a
  live e2e attestation run against the real endpoint is still warranted
  before migrating mainnet holders, in case of future drift.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/counterpartyBridge/counterpartyBridge.test.js
```

Requires Node 22 (`isolated-vm`).

## License

MIT, like every template in this library.
