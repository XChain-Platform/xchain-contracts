// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// urlOracle.js: example contract that reads data from an off-chain URL.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// A contract CANNOT fetch a URL directly: the VM sandbox strips `fetch`,
// `Date`, timers, etc. so every validator computes the same result (consensus
// is bit-for-bit deterministic). Instead the contract *asks* the network to
// read the URL for it, via the attestation framework:
//
//   1. requestPrice(url)  -> emits an ATTEST `http_get` request and remembers
//                            its deterministic request_id.
//   2. (off-chain)         N providers GET the URL, sign the body, the indexer
//                            anchors the agreed response on-chain.
//   3. onPrice(request_id) -> the indexer calls this back; the contract reads
//                            the settled body via attestation.getResponse and
//                            commits it to state.
//
// This is the only correct way for contract logic to depend on arbitrary
// off-chain HTTP data without breaking determinism.
//
// KNOWN LIMITATIONS (this is a teaching example)
//
// Both omissions below are deliberate, to keep the round-trip legible. They are
// stated here rather than only in the README because `scaffold` copies this
// source file and nothing else, so a fork inherits the gaps either way.
//
//   - The callback is NOT pinned to the pending request. `onPrice` commits any
//     request_id carrying a settled `ok` response for this contract, so an
//     earlier settled response can be replayed by any caller to overwrite
//     `price` and clear an in-flight `pending`. A production fork should require
//     request_id === state.get('pending') before committing; the escrowDelivery
//     template in this library does exactly that (search it for 'not the
//     outstanding delivery request').
//   - No access control on `requestPrice`. Anyone can point the contract at any
//     URL. A production fork should restrict the caller, or fix the URL at
//     deploy time.

module.exports = {

    // Contract identity, read off this export at deploy and recorded on chain:
    // consensus REQUIRES name and description under CONTRACT_META_REQUIRED, and
    // meta.version must be bumped on any edit to this source (see CONTRIBUTING.md).
    meta: {
        name:        'URL Oracle',
        description: 'Teaching example of reading off-chain HTTP data on chain: it emits an ATTEST http_get request for a URL and stores the price the network agrees on in its callback, deliberately leaving the callback unpinned and the requester unrestricted so a fork sees the gaps it must close.',
 version: '1.0.1'
    },

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/contract-abi.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        requestPrice: { summary: 'Ask the network to GET url via the http_get attestation provider, returning the request id', params: [ { name: 'url', type: 'string' } ] },
 // onPrice's params ARE the indexer's fixed attestation preamble (attest.js
 // _injectCallbackExecute); requestPrice() registers an empty context array, so
 // the wire is exactly those four slots even though the body reads only slot 0.
 onPrice: { summary: 'Attestation callback fired by the indexer once the body settles; commits it to state (not user-callable)', params: [ { name: 'requestId', type: 'string' }, { name: 'providerId', type: 'string' }, { name: 'status', type: 'string' }, { name: 'responsePayload', type: 'string' } ] },
        price:        { summary: 'Read the last settled body', params: [], view: true }
    } },

    // Ask the network to fetch `url`. Stores the request_id under `pending` and
    // returns it to the caller. `onPrice` does NOT check the id it is handed
    // against `pending` - see KNOWN LIMITATIONS above.
    requestPrice: function (xchain) {
        var url = xchain.getInputParam(0);
        xchain.require(typeof url === 'string' && url.length > 0, 'url required');

        var requestId = xchain.attestation.request(
            'http_get',          // providerId: the HTTP GET attestation provider
            url,                 // requestPayload: the URL to fetch
            'onPrice',           // callbackMethod: invoked once the body settles
            [],                  // callbackParams: extra context (none here)
            { redundancy: 1, deadlineBlocks: 10 }
        );

        xchain.state.set('pending', requestId);
        xchain.log('requested', url, requestId);
        return requestId;
    },

 // Callback fired by the indexer after the off-chain GET has settled. Invoked as
 // onPrice(request_id, provider_id, status, response_payload, ...callbackParams):
 // the first four are the injector's fixed preamble (xchain-indexer's
 // _injectCallbackExecute), and requestPrice() registers no extra context, so the
 // wire is those four slots. This body needs only slot 0 - the response itself is
 // read back through attestation.getResponse() rather than off slot 3 - but the
 // other three arrive regardless and the abi above declares them.
    onPrice: function (xchain) {
        var requestId = xchain.getInputParam(0);

        var resp = xchain.attestation.getResponse(requestId);
        xchain.require(resp !== null, 'no response yet');
        xchain.require(resp.status === 'ok', 'attestation failed: ' + resp.status);

        // resp.payload is the URL body the providers agreed on (a string).
        xchain.state.set('price', resp.payload);
        xchain.state.delete('pending');
        xchain.log('settled', requestId, resp.payload);
        return resp.payload;
    },

    // Read the last settled value.
    price: function (xchain) {
        return xchain.state.get('price');
    }
};
