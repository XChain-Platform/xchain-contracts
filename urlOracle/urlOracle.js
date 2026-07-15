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

module.exports = {
    // Ask the network to fetch `url`. Stores the pending request_id so the
    // callback can be correlated, and returns it to the caller.
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

    // Callback fired by the indexer after the off-chain GET has settled.
    // Invoked as onPrice(request_id, ...callbackParams).
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
