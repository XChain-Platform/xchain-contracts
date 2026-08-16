// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// counterpartyBridge.js: mint XChain tokens 1:1 against burned Counterparty assets
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
// A burn-to-mint bridge for a single Counterparty asset. Counterparty rides
// on top of Bitcoin (its balances are computed by Counterparty nodes from
// OP_RETURN/bare-multisig data embedded in ordinary Bitcoin transactions), so
// the VM sandbox cannot see Counterparty state directly, and even if it
// could, no two validators would necessarily agree on a third-party
// Counterparty indexer's interpretation. This bridge uses the same
// off-chain attestation pattern as `urlOracle`: it asks the network to GET
// tokenscan.io's public "sends" API (https://tokenscan.io/api#sends) and
// anchors the agreed response on-chain before trusting it.
//
// The bridge is genuinely 1:1, not a snapshot: minting is gated on the
// holder having sent `cpAsset` to a well-known, unspendable Counterparty
// "burn" address (BURN_ADDRESS below - no known private key has ever
// signed for it). A holder cannot claim and then also keep/sell the
// original asset on Counterparty, because the asset is gone the moment the
// burn transaction confirms - unlike a balance-snapshot design, which can
// only ever observe a point-in-time holding, not its permanent removal.
//
//   1. requestClaim() -> the caller asks the network to list every "Send"
//      Counterparty transaction that has ever landed on BURN_ADDRESS. Emits
//      an ATTEST http_get request, remembers its request_id.
//   2. (off-chain) N providers GET the API, sign the body, the indexer
//      anchors the agreed response on-chain.
//   3. onClaim(request_id, address) -> the indexer calls this back. Every
//      settled send whose `source` is `address`, whose `asset` is `cpAsset`,
//      and whose Counterparty `tx_hash` has not already been credited is
//      summed and minted in one shot; each `tx_hash` is then marked
//      permanently credited (the nullifier - keyed by burn transaction, not
//      by address, so the same address can burn-and-claim again later).
//
// Because the Counterparty holder's Bitcoin address IS the caller's XChain
// address on that chain (XChain transactions ARE Bitcoin/Dogecoin/Litecoin
// transactions), the claim needs no separate registration step: the address
// that burned the asset is the address the minted tokens land on.
//
// SCOPE: this bridges ONE Counterparty asset to ONE XChain tick per deploy
// (deploy one instance per asset you want to migrate) - see "Known
// limitations" in the README, especially around BURN_ADDRESS being a
// globally shared, industry-wide burn address.
// ---------------------------------------------------------------------------

// A widely-recognized, industry-standard Bitcoin "burn" address: valid
// checksum, but nobody has ever demonstrated a private key for it, so any
// asset sent there is permanently unspendable. It is NOT specific to this
// bridge - many unrelated projects burn to the same address (see "Known
// limitations" in the README for what that shared usage costs this design).
var BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE';

// True only for a plain fixed-notation decimal: digits, with at most one decimal
// point that has digits on both sides. Same shape check as
// priceBet.js:requirePlainDecimal, but a PREDICATE rather than a require(), for
// the reason spelled out at its call site in extractBurnSends.
//
// No RegExp: the VM's syntax validator bans RegExp literals in contract source, so
// this is a character walk.
function isPlainDecimal(value) {
    var s = String(value);
    if (s.length === 0) return false;
    var seenDot = false;
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '.') {
            if (seenDot) return false;
            if (i === 0 || i === s.length - 1) return false;
            seenDot = true;
        } else if (c < '0' || c > '9') {
            return false;
        }
    }
    return true;
}

// Quantise a computed amount DOWN to xchainTick's decimal grid before minting.
// The indexer re-normalises every emitted amount to the tick's decimals at
// ledger-write time (mathjs HALF-UP round: the indexer's bcmath rounds half-up,
// NOT half-even, the mode is stated in xchain-indexer/src/xchainPrice.js and
// pinned by test, because a mis-read mode at the .5 boundary is a consensus
// fork), which can round a computed
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

// Pull every Counterparty "Send" of `asset` FROM `source` out of a
// tokenscan.io GET /api/sends/{destination}/{page}/{limit} body:
//   { "data": [ { "asset": "...", "source": "...", "destination": "...",
//                 "quantity": "...", "status": "valid", "tx_hash": "..." },
//               ... ], "total": N }
// Returns [] (never throws) on anything that does not match - malformed
// JSON, an unexpected shape, or simply no matching rows - so all of those
// collapse to "nothing burned yet" rather than a crash. Only `status ===
// 'valid'` rows count (Counterparty can carry invalid/unconfirmed sends).
function extractBurnSends(payload, asset, source) {
    var parsed;
    try { parsed = JSON.parse(payload); } catch (e) { return []; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) return [];

    var out = [];
    for (var i = 0; i < parsed.data.length; i++) {
        var row = parsed.data[i];
        // `quantity` is the ONE field of this third-party payload that gets used as
        // a number, and onClaim() hands it straight to floorToDecimals, which is
        // string surgery that PRESUPPOSES fixed notation. Every other template
        // feeds that helper a value xchain.math computed (always fixed notation);
        // here it is raw text an API we do not control chose the spelling of, and
        // a JSON number serialized in exponential form is a legal spelling of the
        // same value. Fed '1.23456789e2' the floor does not no-op, it CORRUPTS:
        // it returns '1.23456789' for a value of 123.456789, so the claimer is
        // credited 1% of what they burned, with no user error involved and no
        // revert to notice.
        //
        // Non-fixed rows are DROPPED here rather than reverting onClaim(), because
        // a revert would roll back the `pending:` delete too and requestClaim()
        // refuses a second check while one is pending: one badly-spelled row from
        // a third party would wedge that address out of the bridge permanently. A
        // dropped row leaves its tx_hash uncredited AND unmarked, so the burn is
        // still claimable on a later, well-formed response. Same fail-soft
        // contract as the malformed-JSON path above.
        if (row && row.asset === asset && row.source === source && row.status === 'valid'
            && typeof row.tx_hash === 'string' && row.tx_hash.length > 0
            && row.quantity !== undefined && row.quantity !== null
            && isPlainDecimal(row.quantity)) {
            out.push({ txHash: row.tx_hash, quantity: String(row.quantity) });
        }
    }
    return out;
}

module.exports = {

    abi: { version: 1, methods: {
        requestClaim: { summary: 'Ask the network to check for new burns of cpAsset the caller sent to BURN_ADDRESS', params: [] },
        onClaim:      { summary: 'Callback: mints the equivalent xchainTick for every newly-found burn transaction', params: ['request_id', 'address'] },
        claimedTotal: { summary: 'Read how much an address has been credited in total so far', params: ['address'], view: true },
        burned:       { summary: 'Check whether a specific Counterparty burn tx_hash has already been credited', params: ['tx_hash'], view: true },
        info:         { summary: 'Read the bridge configuration and progress', params: [], view: true }
    } },

    // initialize(cpAsset, xchainTick, maxSupply, decimals)
    // Issues xchainTick (contract-owned) with a hard cap of maxSupply - set
    // this to cpAsset's known total supply so the bridge can never mint more
    // XChain-side than exists Counterparty-side, no matter how many
    // addresses burn-and-claim. decimals must match how the sends API
    // reports `quantity` for this asset (8 for a divisible Counterparty
    // asset, 0 for an indivisible one - see /api/asset/{asset} on the same
    // API to check) so claimed amounts land on the tick's real grid.
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
            description: 'XChain bridge of Counterparty asset ' + cpAsset + ' (burn-to-mint via ' + BURN_ADDRESS + ')'
        });
    },

    // requestClaim(): the caller asks the network to list every Send
    // Counterparty has ever recorded landing on BURN_ADDRESS. Self-serve by
    // design (getSourceAddress() is both the address whose burns get
    // scanned and, once onClaim settles, the mint destination) - nobody can
    // trigger a check that would then mint to a third party. Unlike a
    // one-shot claim, this can be called again later once new burns exist
    // (only ONE check may be in flight per address at a time).
    requestClaim: function (xchain) {
        var caller = xchain.getSourceAddress();
        xchain.require(!xchain.state.get('pending:' + caller), 'a claim check is already pending for this address');

        // tokenscan.io has no source+asset-filtered endpoint - it returns
        // every Send that ever landed on BURN_ADDRESS, across every asset
        // and every sender, paged. The limit here is NOT a generous
        // headroom choice - it is bounded hard by the indexer's on-chain
        // attestation-response payload cap (8192 bytes total ACTION data;
        // each row of this feed runs ~200-250 bytes, so anything close to
        // tokenscan's own page-size ceiling would never fit on-chain at
        // all). See README "Known limitations" for what this costs once
        // global traffic to this shared address grows.
        var url = 'https://cp20.tokenscan.io/api/sends/' + BURN_ADDRESS + '/1/15';

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

    // onClaim(request_id, address): the indexer's callback once the burn
    // list settles. Pinned to the outstanding request for THIS address (like
    // escrowDelivery's onDelivery, not urlOracle's teaching-example gap) so a
    // stale settled response for an earlier request can't be replayed. Sums
    // every not-yet-credited burn found for `address`, mints once, and
    // nullifies each burn's tx_hash individually. Finding zero new burns, or
    // a failed attestation, is a no-op - pending clears and the address can
    // requestClaim() again later once they actually burn something.
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

        var resp = xchain.attestation.getResponse(requestId);
        xchain.require(resp !== null, 'no response yet');

        if (resp.status !== 'ok') {
            xchain.state.delete('pending:' + address);
            xchain.log('burn check failed', requestId, resp.status);
            return 'not confirmed';
        }

        var cpAsset = xchain.state.get('cpAsset');
        var sends = extractBurnSends(resp.payload, cpAsset, address);
        var decimals = parseInt(xchain.state.get('decimals'), 10);

        // Sum every burn tx not already credited, without mutating state yet
        // (a require() below can still revert this whole callback, and any
        // state already touched would roll back with it - but computing
        // first keeps the intent readable).
        var totalNew = '0';
        var newTxHashes = [];
        for (var i = 0; i < sends.length; i++) {
            var s = sends[i];
            if (xchain.state.get('burned:' + s.txHash)) continue;
            var amount = floorToDecimals(s.quantity, decimals);
            if (!xchain.math.gt(amount, '0')) continue;
            totalNew = xchain.math.add(totalNew, amount);
            newTxHashes.push(s.txHash);
        }

        xchain.state.delete('pending:' + address);

        if (!xchain.math.gt(totalNew, '0')) {
            xchain.log('no new burns found', requestId);
            return 'no burns to claim';
        }

        var newTotalClaimed = xchain.math.add(xchain.state.get('totalClaimed'), totalNew);
        xchain.require(xchain.math.lte(newTotalClaimed, xchain.state.get('maxSupply')),
            'bridge maxSupply exhausted');

        // Mark every burn tx credited BEFORE emitting, so a defense-in-depth
        // replay of the same settled response (see attacks-considered test)
        // can never double-mint against the same burn.
        for (var j = 0; j < newTxHashes.length; j++) {
            xchain.state.set('burned:' + newTxHashes[j], true);
        }
        xchain.state.set('totalClaimed', newTotalClaimed);
        xchain.state.set('claimedTotal:' + address,
            xchain.math.add(xchain.state.get('claimedTotal:' + address) || '0', totalNew));

        xchain.emit.mint({
            tick: xchain.state.get('xchainTick'),
            quantity: totalNew,
            destination: address
        });
        xchain.log('claimed', address, totalNew, newTxHashes.length);
        return totalNew;
    },

    claimedTotal: function (xchain) {
        var address = xchain.getInputParam(0);
        xchain.require(typeof address === 'string' && address.length > 0, 'address required');
        return xchain.state.get('claimedTotal:' + address) || '0';
    },

    burned: function (xchain) {
        var txHash = xchain.getInputParam(0);
        xchain.require(typeof txHash === 'string' && txHash.length > 0, 'tx_hash required');
        return !!xchain.state.get('burned:' + txHash);
    },

    info: function (xchain) {
        return JSON.stringify({
            cpAsset: xchain.state.get('cpAsset'),
            xchainTick: xchain.state.get('xchainTick'),
            decimals: xchain.state.get('decimals'),
            maxSupply: xchain.state.get('maxSupply'),
            totalClaimed: xchain.state.get('totalClaimed'),
            burnAddress: BURN_ADDRESS
        });
    }
};
