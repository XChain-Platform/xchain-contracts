// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// counterpartyBridge.js: mint the XChain equivalent of a Counterparty holding
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. See the MIT
// License for the full text.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// A one-time migration bridge for holders of a single Counterparty asset.
// Counterparty rides on top of Bitcoin (its balances are computed by Counterparty
// nodes from OP_RETURN/bare-multisig data embedded in ordinary Bitcoin
// transactions), so a holder's Counterparty balance is NOT something the VM
// can see directly - the sandbox has no Bitcoin/Counterparty node access, and
// even if it did, no two validators would necessarily agree on a
// Counterparty indexer's current interpretation. Instead this bridge uses the
// SAME off-chain attestation pattern as `urlOracle`: it asks the network to
// GET a Counterparty balance API (tokenscan.io's REST API, see
// https://tokenscan.io/api#balances) and anchors the agreed response
// on-chain.
//
//   1. requestClaim() -> the caller asks the network to fetch their own
//      balance of `cpAsset` from a Counterparty balances API. Emits an ATTEST
//      http_get request, remembers its request_id.
//   2. (off-chain) N providers GET the API, sign the body, the indexer
//      anchors the agreed response on-chain.
//   3. onClaim(request_id, address) -> the indexer calls this back. If the
//      settled body reports a positive balance, that exact amount of
//      `xchainTick` is MINTED to the claiming address, and the address is
//      marked claimed so it can never claim again.
//
// Because the Counterparty holder's Bitcoin address IS the caller's XChain
// address on that chain (XChain transactions ARE Bitcoin/Dogecoin/Litecoin
// transactions), the claim needs no separate registration step: the address
// that asks for the check is the address the minted tokens land on.
//
// SCOPE: this bridges ONE Counterparty asset to ONE XChain tick per deploy
// (deploy one instance per asset you want to migrate), and it is a ONE-TIME
// snapshot claim per address, not a live pegged balance - see "Known
// limitations" in the README.
// ---------------------------------------------------------------------------

// Quantise a computed amount DOWN to xchainTick's decimal grid before minting.
// The indexer re-normalises every emitted amount to the tick's decimals at
// ledger-write time (mathjs half-even round), which can round a computed
// quantity UP past maxSupply and revert the whole EXECUTE (see crowdsale.js
// for the same footgun in more detail). Pure exact string surgery on the
// fixed-notation decimal, not mathjs floor/mod (which rounds to significant
// digits, not the decimal grid).
function floorToDecimals(value, decimals) {
    var s = String(value);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.substring(1);
    var dot = s.indexOf('.');
    if (dot < 0) return value;
    var frac = s.substring(dot + 1);
    if (frac.length <= decimals) return value;
    var kept = decimals > 0 ? '.' + frac.substring(0, decimals) : '';
    var out = s.substring(0, dot) + kept;
    return neg ? '-' + out : out;
}

// Pull the normalized balance of `asset` out of a tokenscan.io
// GET /api/balances/{address}/{page}/{limit} body:
//   { "address": "...", "data": [ { "asset": "PEPECASH", "quantity": "650000.00000000", ... }, ... ], "total": N }
// tokenscan reports one wallet's ENTIRE holdings as an array (there is no
// single-address+single-asset endpoint), already normalized (`quantity` is a
// decimal string, not a raw integer needing an extra divisibility divide).
// Returns null (never throws) on anything that does not match - malformed
// JSON, an unexpected shape, or the asset simply not present in `data` (the
// address does not hold it) - so all of those collapse to "no balance found"
// rather than a crash.
function extractAssetQuantity(payload, asset) {
    var parsed;
    try { parsed = JSON.parse(payload); } catch (e) { return null; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) return null;

    for (var i = 0; i < parsed.data.length; i++) {
        var row = parsed.data[i];
        if (row && row.asset === asset && row.quantity !== undefined && row.quantity !== null) {
            return String(row.quantity);
        }
    }
    return null;
}

module.exports = {

    abi: { version: 1, methods: {
        requestClaim: { summary: 'Ask the network to check the caller\'s Counterparty balance', params: [] },
        onClaim:      { summary: 'Callback: mints the equivalent xchainTick if a positive balance settled', params: ['request_id', 'address'] },
        claimed:      { summary: 'Read how much an address has already claimed', params: ['address'], view: true },
        info:         { summary: 'Read the bridge configuration and progress', params: [], view: true }
    } },

    // initialize(cpAsset, xchainTick, maxSupply, decimals)
    // Issues xchainTick (contract-owned) with a hard cap of maxSupply - set
    // this to cpAsset's known total supply so the bridge can never mint more
    // XChain-side than exists Counterparty-side, no matter how many addresses
    // claim. decimals must match how the balances API reports `quantity` for
    // this asset (8 for a divisible Counterparty asset, 0 for an indivisible
    // one - see /api/asset/{asset} on the same API to check) so claimed
    // amounts land on the tick's real grid.
    initialize: function (xchain) {
        var cpAsset    = xchain.getInputParam(0);
        var xchainTick = xchain.getInputParam(1);
        var maxSupply  = xchain.getInputParam(2);
        var decimals   = xchain.getInputParam(3) || '8';

        xchain.require(typeof cpAsset === 'string' && cpAsset.length > 0, 'cpAsset required');
        xchain.require(typeof xchainTick === 'string' && xchainTick.length > 0, 'xchainTick required');
        xchain.require(maxSupply && xchain.math.gt(maxSupply, '0'), 'maxSupply must be positive');

        var decInt = parseInt(decimals, 10);
        xchain.require(String(decInt) === String(decimals) && decInt >= 0 && decInt <= 18,
            'decimals must be an integer 0-18');

        xchain.state.set('cpAsset', cpAsset);
        xchain.state.set('xchainTick', xchainTick);
        xchain.state.set('maxSupply', maxSupply);
        xchain.state.set('decimals', decimals);
        xchain.state.set('totalClaimed', '0');

        xchain.emit.issue({
            tick: xchainTick,
            maxSupply: maxSupply,
            maxMint: maxSupply,
            decimals: decimals,
            description: 'XChain bridge of Counterparty asset ' + cpAsset
        });
    },

    // requestClaim(): the caller asks the network to fetch THEIR OWN
    // Counterparty balance of cpAsset. Self-serve by design (getSourceAddress()
    // is both the queried address and, once onClaim settles, the mint
    // destination) - nobody can trigger a check on someone else's behalf that
    // would then mint to a third party.
    requestClaim: function (xchain) {
        var caller = xchain.getSourceAddress();
        xchain.require(!xchain.state.get('claimed:' + caller), 'already claimed');
        xchain.require(!xchain.state.get('pending:' + caller), 'a claim check is already pending for this address');

        // tokenscan.io has no single-address+single-asset endpoint - it
        // returns a wallet's entire holdings, paged. Page 1 / limit 500
        // covers any realistic migration wallet in one response; a holder
        // with 500+ distinct Counterparty assets could fall past this page
        // (see README "Known limitations").
        var url = 'https://cp20.tokenscan.io/api/balances/' + caller + '/1/500';

        var requestId = xchain.attestation.request(
            'http_get',
            url,
            'onClaim',
            [caller],
            { redundancy: 3, deadlineBlocks: 20 }
        );

        xchain.state.set('pending:' + caller, requestId);
        xchain.log('claim requested', caller, requestId);
        return requestId;
    },

    // onClaim(request_id, address): the indexer's callback once the balance
    // check settles. Pinned to the outstanding request for THIS address (like
    // escrowDelivery's onDelivery, not urlOracle's teaching-example gap) so a
    // stale settled response for an earlier request can't be replayed. A
    // zero/missing balance or a failed attestation is a no-op, not a revert -
    // pending clears and the address can requestClaim() again later (they may
    // simply not have acquired the asset yet at check time).
    onClaim: function (xchain) {
        // The indexer invokes attestation callbacks with the fixed preamble
        // [request_id, provider_id, status, response_payload] followed by
        // whatever custom context array was passed to attestation.request()
        // (see xchain-indexer's _injectCallbackExecute). requestClaim() passed
        // [caller] as that context, so the address we asked about is param 4,
        // not param 1 - param 1 is the provider_id ('http_get').
        var requestId = xchain.getInputParam(0);
        var address = xchain.getInputParam(4);
        xchain.require(requestId === xchain.state.get('pending:' + address),
            'not the outstanding claim request for this address');

        if (xchain.state.get('claimed:' + address)) {
            xchain.state.delete('pending:' + address);
            return 'ignored: already claimed';
        }

        var resp = xchain.attestation.getResponse(requestId);
        xchain.require(resp !== null, 'no response yet');

        if (resp.status !== 'ok') {
            xchain.state.delete('pending:' + address);
            xchain.log('balance check failed', requestId, resp.status);
            return 'not confirmed';
        }

        var balance = extractAssetQuantity(resp.payload, xchain.state.get('cpAsset'));
        if (balance === null || !xchain.math.gt(balance, '0')) {
            xchain.state.delete('pending:' + address);
            xchain.log('no balance found', requestId);
            return 'no balance to claim';
        }

        var decimals = parseInt(xchain.state.get('decimals'), 10);
        var amount = floorToDecimals(balance, decimals);
        xchain.require(xchain.math.gt(amount, '0'), 'balance below one token unit');

        var totalClaimed = xchain.math.add(xchain.state.get('totalClaimed'), amount);
        xchain.require(xchain.math.lte(totalClaimed, xchain.state.get('maxSupply')),
            'bridge maxSupply exhausted');

        // Mark claimed BEFORE emitting so a second settled response for the
        // same address (defense in depth over the pending-pin check above)
        // can never mint twice.
        xchain.state.set('claimed:' + address, amount);
        xchain.state.set('totalClaimed', totalClaimed);
        xchain.state.delete('pending:' + address);

        xchain.emit.mint({
            tick: xchain.state.get('xchainTick'),
            quantity: amount,
            destination: address
        });
        xchain.log('claimed', address, amount);
        return amount;
    },

    claimed: function (xchain) {
        var address = xchain.getInputParam(0);
        xchain.require(typeof address === 'string' && address.length > 0, 'address required');
        return xchain.state.get('claimed:' + address) || '0';
    },

    info: function (xchain) {
        return JSON.stringify({
            cpAsset: xchain.state.get('cpAsset'),
            xchainTick: xchain.state.get('xchainTick'),
            decimals: xchain.state.get('decimals'),
            maxSupply: xchain.state.get('maxSupply'),
            totalClaimed: xchain.state.get('totalClaimed')
        });
    }
};
