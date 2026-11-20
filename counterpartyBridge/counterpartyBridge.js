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
// A burn-to-mint bridge for a single Counterparty asset. Counterparty balances
// are computed by Counterparty nodes from data embedded in ordinary Bitcoin
// transactions, so the VM sandbox cannot see them, and validators need not
// agree on a third-party indexer's reading. Like `urlOracle`, this bridge asks
// the network to GET tokenscan.io's public "sends" API
// (https://tokenscan.io/api#sends) and anchors the agreed response on-chain.
//
// The bridge is genuinely 1:1, not a snapshot: minting is gated on the holder
// having sent `cpAsset` to a well-known unspendable "burn" address
// (BURN_ADDRESS below). The asset is gone the moment the burn confirms, so a
// holder cannot claim and also keep or sell it, which a balance snapshot can
// never rule out.
//
//   1. requestClaim() -> the caller asks the network to list every "Send"
//      Counterparty transaction that has ever landed on BURN_ADDRESS. Emits
//      an ATTEST http_get request, remembers its request_id.
//   2. (off-chain) N providers GET the API, sign the body, the indexer
//      anchors the agreed response on-chain.
//   3. onClaim(request_id, address) -> the indexer calls this back. Every
//      settled send of `cpAsset` from `address` whose `tx_hash` is not yet
//      credited is summed and sent from custody in one shot, and each
//      `tx_hash` is marked credited (the nullifier is keyed by burn, not by
//      address, so an address can burn and claim again later).
//
// CUSTODY MODEL: an XChain MINT is not issuer-gated (any address may MINT a
// tick that sets no LOCK_MINT or allow list), so the deploy pre-mints the
// whole maxSupply into this contract with LOCK_MINT and LOCK_MINT_SUPPLY set,
// and claims are paid by SEND. No outside MINT can then create unbacked
// supply or fill the cap ahead of a real claimant. (Owner WITHDRAW of this
// custody is the remaining trust edge; see "Known limitations" in the README.)
//
// The holder's Bitcoin address IS the caller's XChain address on that chain,
// so no registration step is needed: the address that burned the asset is the
// address the tokens land on.
//
// SCOPE: ONE Counterparty asset to ONE XChain tick per deploy. See "Known
// limitations" in the README, especially on BURN_ADDRESS being shared
// industry-wide.
// ---------------------------------------------------------------------------

// An industry-standard Bitcoin burn address: valid checksum, no known private
// key, so anything sent there is unspendable. Many unrelated projects burn to
// it too; see "Known limitations" in the README for what that costs.
var BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE';
// Permanent credit keys and in-flight request keys share the VM's 10,000-key
// state budget. These ceilings leave room for fixed configuration keys.
var MAX_CREDIT_KEYS = 9000;
var MAX_PENDING = 900;

// True only for a plain fixed-notation decimal: digits, with at most one decimal
// point that has digits on both sides. Same shape check as
// patterns/validation.js:requirePlainDecimal, but a PREDICATE rather than a
// require(), for the reason spelled out at its call site in extractBurnSends.
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

function isHexTxHash(value) {
    if (typeof value !== 'string' || value.length !== 64) return false;
    for (var i = 0; i < value.length; i++) {
        var c = value.charAt(i);
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}

// Quantise a computed amount DOWN to xchainTick's decimal grid before minting.
// The indexer re-rounds every emitted amount to the tick's decimals HALF-UP
// (stated in xchain-indexer/src/consensus/xchain_price.js and pinned by test),
// which can push a quantity past maxSupply and revert the EXECUTE (crowdsale.js
// has the same footgun). Exact string surgery, not mathjs floor/mod, which
// rounds to significant digits rather than the decimal grid.
function floorToDecimals(value, decimals) {
    var s = String(value);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.substring(1);
    var dot = s.indexOf('.');
    if (dot < 0) return value;                          // already an integer
    var frac = s.substring(dot + 1);
    if (frac.length <= decimals) return value;          // already on the grid
    var kept = decimals > 0 ? '.' + frac.substring(0, decimals) : '';
    var out = s.substring(0, dot) + kept;
    return neg ? '-' + out : out;
}

// Return true when a >= b exactly, by the sign of the exact subtract ('-0' is zero).
// xchain.math.gte is tolerant (1e-12 relative). Same helper as amm.js.
function isAtLeastExact(xchain, a, b) {
    var diff = String(xchain.math.subtract(a, b));
    var neg = diff.charAt(0) === '-';
    var nonzero = false;
    for (var i = neg ? 1 : 0; i < diff.length; i++) {
        var c = diff.charAt(i);
        if (c >= '1' && c <= '9') nonzero = true;
        else if (c !== '0' && c !== '.') return false;
    }
    return !(neg && nonzero);
}

// Pull every Counterparty "Send" of `asset` FROM `source` out of a
// tokenscan.io GET /api/sends/{destination}/{page}/{limit} body:
//   { "data": [ { "asset": "...", "source": "...", "destination": "...",
//                 "quantity": "...", "status": "valid", "tx_hash": "..." },
//               ... ], "total": N }
// Returns [] (never throws) on malformed JSON, an unexpected shape or no
// matching rows, so each reads as "nothing burned yet". Only `status ===
// 'valid'` rows count.
function extractBurnSends(payload, asset, source) {
    var parsed;
    try { parsed = JSON.parse(payload); } catch (e) { return []; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) return [];

    var out = [];
    for (var i = 0; i < parsed.data.length; i++) {
        var row = parsed.data[i];
        // `quantity` is third-party text handed to floorToDecimals, which
        // presupposes fixed notation: fed '1.23456789e2' it returns '1.23456789'
        // for 123.456789 and silently credits 1% of the burn. Only a JSON string
        // is taken, since JSON.parse already rounded a JSON number to a double.
        // `tx_hash` becomes a state key, so only 64 hex characters are taken,
        // lowercased so one burn has one nullifier; anything else could make the
        // key write throw. Bad rows are DROPPED rather than reverting onClaim(): a
        // revert restores `pending:` and wedges the address out of requestClaim().
        // A dropped row stays unmarked, so the burn is claimable on a later
        // well-formed response, the same fail-soft contract as malformed JSON.
        if (row && row.asset === asset && row.source === source && row.status === 'valid'
            && isHexTxHash(row.tx_hash)
            && typeof row.quantity === 'string'
            && isPlainDecimal(row.quantity)) {
            out.push({ txHash: row.tx_hash.toLowerCase(), quantity: row.quantity });
        }
    }
    return out;
}

function collectNewBurns(xchain, sends, decimals) {
    var total = '0';
    var hashes = [];
    // burned: keys are written only in completeClaim, so a repeat within one page
    // is filtered here (first row wins); the h: prefix keeps __proto__ a plain key.
    var seen = {};
    for (var i = 0; i < sends.length; i++) {
        var send = sends[i];
        if (Object.prototype.hasOwnProperty.call(seen, 'h:' + send.txHash)) continue;
        if (xchain.state.get('burned:' + send.txHash)) continue;
        var amount = floorToDecimals(send.quantity, decimals);
        if (isAtLeastExact(xchain, '0', amount)) continue;
        seen['h:' + send.txHash] = true;
        total = xchain.math.add(total, amount);
        hashes.push(send.txHash);
    }
    return { total: total, hashes: hashes };
}

function completeClaim(xchain, address, claim) {
    var newTotalClaimed = xchain.math.add(xchain.state.get('totalClaimed'), claim.total);
    // Fail soft, never revert: a revert restores pending:<addr> while the same
    // over-cap page keeps replaying, locking the address out of requestClaim.
    if (!isAtLeastExact(xchain, xchain.state.get('maxSupply'), newTotalClaimed)) {
        xchain.log('bridge maxSupply exhausted', address, claim.total);
        return 'maxSupply exhausted';
    }

    var claimedKey = 'claimedTotal:' + address;
    var needed = claim.hashes.length + (xchain.state.get(claimedKey) === null ? 1 : 0);
    var creditKeys = parseInt(xchain.state.get('creditKeys'), 10);
    if (creditKeys + needed > MAX_CREDIT_KEYS) {
        xchain.log('bridge key limit reached', address, claim.total);
        return 'key limit reached';
    }

    for (var i = 0; i < claim.hashes.length; i++)
        xchain.state.set('burned:' + claim.hashes[i], true);
    xchain.state.set('totalClaimed', newTotalClaimed);
    xchain.state.set(claimedKey,
        xchain.math.add(xchain.state.get(claimedKey) || '0', claim.total));
    xchain.state.set('creditKeys', String(creditKeys + needed));

    xchain.emit.send({
        destination: address,
        tick: xchain.state.get('xchainTick'),
        quantity: claim.total,
        memo: 'counterpartyBridge claim'
    });
    xchain.log('claimed', address, claim.total, claim.hashes.length);
    return claim.total;
}

module.exports = {

    // Contract identity, read off this export at deploy and recorded on chain:
    // consensus REQUIRES name and description under CONTRACT_META_REQUIRED, and
    // meta.version must be bumped on any edit to this source (see CONTRIBUTING.md).
    meta: {
        name:        'Counterparty Bridge',
        description: 'Burn-to-mint bridge for a single Counterparty asset: a holder burns the asset to a well-known unspendable address, an off-chain attestation of the tokenscan.io sends API confirms the burn, and the contract then sends the migrated tokens one for one from a supply pre-minted into its own custody with public MINT locked.',
        version:     '1.5.0'
    },

    abi: { version: 1, methods: {
        requestClaim: { summary: 'Ask the network to check for new burns of cpAsset the caller sent to BURN_ADDRESS', params: [] },
        // onClaim's first four params are the indexer's fixed attestation preamble
        // (attest/index.js injectCallbackExecute); requestClaim() appends [caller], so the
        // credited address is slot 4 and the whole list is machine-supplied.
        onClaim:      { summary: 'Callback: sends the equivalent xchainTick from custody for every newly-found burn transaction; the indexer supplies the attestation preamble and the credited address (not user-callable)', params: [ { name: 'requestId', type: 'string' }, { name: 'providerId', type: 'string' }, { name: 'status', type: 'string' }, { name: 'responsePayload', type: 'json' }, { name: 'address', type: 'address' } ] },
        claimedTotal: { summary: 'Read how much an address has been credited in total so far', params: [ { name: 'address', type: 'address' } ], view: true },
        burned:       { summary: 'Check whether a specific Counterparty burn tx_hash has already been credited', params: [ { name: 'txHash', type: 'string' } ], view: true },
        info:         { summary: 'Read the bridge configuration and progress', params: [], view: true }
    } },

    // initialize(cpAsset, xchainTick, maxSupply, decimals)
    // Issues xchainTick capped at maxSupply: set it to cpAsset's total supply so
    // the bridge never pays out more than exists Counterparty-side. decimals must
    // match how the sends API reports `quantity` (8 divisible, 0 indivisible; see
    // /api/asset/{asset}) so claimed amounts land on the tick's real grid.
    initialize: function (xchain) {
        var cpAsset    = xchain.getInputParam(0);
        var xchainTick = xchain.getInputParam(1);
        var maxSupply  = xchain.getInputParam(2);
        var decimals   = xchain.getInputParam(3) || '8';

        xchain.require(typeof cpAsset === 'string' && cpAsset.length > 0, 'cpAsset required');
        xchain.require(typeof xchainTick === 'string' && xchainTick.length > 0, 'xchainTick required');
        // Gate the notation of maxSupply: it is emitted verbatim as the ISSUE's supply.
        xchain.require(isPlainDecimal(maxSupply),
            'maxSupply must be a plain decimal: digits and one optional decimal point');
        xchain.require(maxSupply && xchain.math.gt(maxSupply, '0'), 'maxSupply must be positive');

        var decInt = parseInt(decimals, 10);
        xchain.require(String(decInt) === String(decimals) && decInt >= 0 && decInt <= 18,
            'decimals must be an integer 0-18');
        // Refuse an off-grid cap exactly (the indexer rounds the pre-mint half-up; '100.50' passes).
        xchain.require(isAtLeastExact(xchain, floorToDecimals(maxSupply, decInt), maxSupply),
            'maxSupply must sit on the decimals grid (at most ' + decInt + ' fractional digits)');

        xchain.state.set('cpAsset', cpAsset);
        xchain.state.set('xchainTick', xchainTick);
        xchain.state.set('maxSupply', maxSupply);
        xchain.state.set('decimals', decimals);
        xchain.state.set('totalClaimed', '0');
        xchain.state.set('creditKeys', '0');
        xchain.state.set('pendingCount', '0');

        // Pre-mint the whole supply into this contract's custody and lock MINT
        // (and any further MINT_SUPPLY), so claims below are the only way out.
        xchain.emit.issue({
            tick: xchainTick,
            maxSupply: maxSupply,
            maxMint: maxSupply,
            decimals: decimals,
            description: 'XChain bridge of Counterparty asset ' + cpAsset + ' (burn-to-mint via ' + BURN_ADDRESS + ')',
            mintSupply: maxSupply,
            lockMint: '1',
            lockMintSupply: '1'
        });
    },

    // requestClaim(): ask the network to list every Send that landed on
    // BURN_ADDRESS. Self-serve: the caller is both the address whose burns are
    // scanned and the payout destination, so nobody can direct a mint to a third
    // party. Callable again for later burns, one check in flight per address.
    requestClaim: function (xchain) {
        var caller = xchain.getSourceAddress();
        xchain.require(!xchain.state.get('pending:' + caller), 'a claim check is already pending for this address');
        var pendingCount = parseInt(xchain.state.get('pendingCount'), 10);
        xchain.require(pendingCount < MAX_PENDING,
            'too many claim checks in flight; retry later');

        // tokenscan.io has no source+asset filter: it pages every Send to
        // BURN_ADDRESS across all assets and senders. The page limit is bounded
        // by the on-chain attestation payload cap (8192 bytes of ACTION data at
        // ~200-250 bytes a row), not chosen for headroom; see README "Known
        // limitations" for what that costs as traffic to the shared address grows.
        var url = 'https://cp20.tokenscan.io/api/sends/' + BURN_ADDRESS + '/1/15';

        var requestId = xchain.attestation.request('http_get', url, 'onClaim', [caller],
            { redundancy: 3, deadlineBlocks: 20 });

        xchain.state.set('pending:' + caller, requestId);
        xchain.state.set('pendingCount', String(pendingCount + 1));
        xchain.log('claim requested', caller, requestId);
        return requestId;
    },

    // onClaim(request_id, address): the indexer's callback once the burn list
    // settles, pinned to the outstanding request for THIS address so a stale
    // response can't be replayed. Sends every not-yet-credited burn once from
    // custody and nullifies each tx_hash. Zero new burns or a failed check is
    // a no-op: pending clears and the address can requestClaim() again.
    onClaim: function (xchain) {
        // Callback params are [request_id, provider_id, status, response_payload]
        // then the context passed to attestation.request() (xchain-indexer's
        // injectCallbackExecute); requestClaim() passed [caller], so it is param 4.
        var requestId = xchain.getInputParam(0);
        var address = xchain.getInputParam(4);
        xchain.require(requestId === xchain.state.get('pending:' + address),
            'not the outstanding claim request for this address');

        // An expired request has no readable row and must settle, not revert (a
        // revert keeps pending and wedges requestClaim). Param 2 is trusted only
        // on the framework's own callback (SOURCE is this contract): anyone may
        // relay an attested response, but a forged 'expired' must not cancel.
        var resp = xchain.attestation.getResponse(requestId);
        var expired = resp === null && xchain.getInputParam(2) !== 'ok' &&
            xchain.getSourceAddress() === xchain.getContractAddress();
        xchain.require(resp !== null || expired, 'no response yet');

        if (expired || resp.status !== 'ok') {
            clearPending(xchain, address);
            xchain.log('burn check failed', requestId, expired ? 'expired' : resp.status);
            return 'not confirmed';
        }

        var cpAsset = xchain.state.get('cpAsset');
        var sends = extractBurnSends(resp.payload, cpAsset, address);
        var decimals = parseInt(xchain.state.get('decimals'), 10);
        var claim = collectNewBurns(xchain, sends, decimals);

        clearPending(xchain, address);

        // Same exact test on the total, so a sub-1e-15 sum is still paid.
        if (isAtLeastExact(xchain, '0', claim.total)) {
            xchain.log('no new burns found', requestId);
            return 'no burns to claim';
        }
        return completeClaim(xchain, address, claim);
    },

    claimedTotal: function (xchain) {
        var address = xchain.getInputParam(0);
        xchain.require(typeof address === 'string' && address.length > 0, 'address required');
        return xchain.state.get('claimedTotal:' + address) || '0';
    },

    burned: function (xchain) {
        var txHash = xchain.getInputParam(0);
        xchain.require(isHexTxHash(txHash), 'tx_hash must be 64 hex characters');
        return !!xchain.state.get('burned:' + txHash.toLowerCase());
    },

    info: function (xchain) {
        return JSON.stringify({
            cpAsset: xchain.state.get('cpAsset'),
            xchainTick: xchain.state.get('xchainTick'),
            decimals: xchain.state.get('decimals'),
            maxSupply: xchain.state.get('maxSupply'),
            totalClaimed: xchain.state.get('totalClaimed'),
            creditKeys: xchain.state.get('creditKeys'),
            maxCreditKeys: String(MAX_CREDIT_KEYS),
            pendingCount: xchain.state.get('pendingCount'),
            maxPending: String(MAX_PENDING),
            burnAddress: BURN_ADDRESS
        });
    }
};

function clearPending(xchain, address) {
    xchain.state.delete('pending:' + address);
    var count = parseInt(xchain.state.get('pendingCount'), 10);
    xchain.state.set('pendingCount', String(count > 0 ? count - 1 : 0));
}
