# urlOracle: read off-chain URL data via the attestation framework

A minimal worked example of the **only correct way** for contract logic to
depend on arbitrary off-chain HTTP data. A contract cannot fetch a URL
directly: the VM sandbox strips `fetch`, `Date`, timers, and everything else
non-deterministic so that every validator computes bit-for-bit the same
result. Instead the contract *asks the network* to read the URL for it:

1. `requestPrice(url)` emits an ATTEST `http_get` request and remembers its
   deterministic `request_id`.
2. Off-chain, N attestation providers GET the URL, sign the body, and the
   indexer anchors the agreed response on-chain.
3. The indexer calls `onPrice(request_id)` back; the contract reads the
   settled body via `attestation.getResponse` and commits it to state.

The settled value is consensus data: every validator sees the same body, so
determinism is preserved.

## Methods

| Method | Who | Effect |
|---|---|---|
| `requestPrice(url)` | anyone | Emits an `http_get` attestation request (`redundancy: 1`, `deadlineBlocks: 10`), stores the pending `request_id`, returns it. |
| `onPrice(request_id)` | indexer callback | Reads the settled response; requires `status === 'ok'`; commits `resp.payload` to the `price` state key. |
| `price()` | anyone | Read-only: the last settled value. |

## Usage

```
EXECUTE(contract, "requestPrice", "https://example.com/price.json")
# ...wait for the attestation to settle (or hit its deadline)...
EXECUTE(contract, "price")   # read the committed body
```

## Attacks we considered

- **Non-determinism via direct fetch.** Impossible by construction: the
  sandbox strips every I/O and time primitive. The attestation framework is
  the only door, and what comes through it is consensus-finalized data.
- **A forged response.** `onPrice` reads the body from
  `xchain.attestation.getResponse(request_id)`, indexer-side consensus state;
  a caller cannot supply the payload. A `request_id` with no settled
  response reverts (`no response yet`), and a failed/disputed attestation
  reverts on the status check.
- **Provider lies about the body.** With `redundancy: 1` a single provider is
  trusted; raise `redundancy` so N providers must agree before the response
  settles. Volatile URLs (per-request timestamps, load balancers returning
  different bodies) will fail to reach agreement; point at stable endpoints.
- **Request that never settles.** `deadlineBlocks` bounds the pending window;
  past it the request settles as failed and `onPrice` reverts on the status
  check instead of committing nothing silently.

## Known limitations (this is a teaching example)

- **Callback is not pinned to the pending request.** `onPrice` accepts any
  `request_id` with a settled `ok` response for this contract, so an old
  settled request could be replayed to overwrite `price` with a stale (but
  genuine, unforgeable) value. A production fork should require
  `request_id === state.get('pending')` before committing.
- **No access control on `requestPrice`.** Anyone can point the contract at
  any URL. A production fork would restrict the caller or fix the URL at
  deploy time.

## Tests

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/urlOracle/urlOracle.test.js
```

Requires Node 22 (`isolated-vm`).

## License

MIT, like every template in this library.
