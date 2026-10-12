// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// vesting.js: linear token vesting with a cliff and optional revocation
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
// A grantor locks tokens for a beneficiary that unlock gradually over time. The
// beneficiary claims whatever has vested so far. With a cliff, nothing vests
// until `cliffBlocks` have passed; after that, the grant vests linearly and is
// fully vested at `durationBlocks`. If created `revocable`, the grantor can
// reclaim the still-unvested portion at any time (the already-vested portion
// stays claimable by the beneficiary).
//
// Time is measured in BLOCKS, not wall-clock. XChain contracts have no clock,
// only deterministic block height (`getBlockHeight()`).
//
// CUSTODY MODEL
//
// XChain has no msg.value. Tokens enter via a separate DEPOSIT to the contract's
// address; fund it in one transaction with BATCH:
//
//     BATCH( DEPOSIT(vesting, TICK, TOTAL), EXECUTE(vesting, "fund") )
//
// A BATCH is NOT atomic: its sub-actions settle independently, so a fund() that
// reverts ('vesting not awaiting funds', 'insufficient deposit') leaves the
// DEPOSIT ahead of it standing in the contract's custody. While the grant is
// still INIT, the grantor takes that deposit back with cancel().
//
// fund() verifies the contract actually holds `total` (via getBalance), that `total`
// fits the tick's decimal grid, and starts the vesting clock from that block. The contract never trusts a caller-supplied
// amount. Deposit EXACTLY `total` of the configured tick; surplus, or any other
// tick, is not recoverable by this template.
// ---------------------------------------------------------------------------

// Upper bound for the two schedule constructor params. A sanity ceiling, not a
// protocol limit: both are compared against a plain JS block height in
// vestedAmount(), so the point is to keep a fat-fingered constructor term inside
// the exactly-representable integer range rather than to constrain a real grant.
// MAX_WINDOW_BLOCKS is 1e6 blocks (~19 years at 10-minute blocks), the same
// ceiling treasury.js, priceBet.js and patterns/validation.js use.
var MAX_WINDOW_BLOCKS = 1000000;

// Quantise a computed amount DOWN onto a tick's decimal grid before emitting it.
// The indexer normalises every emitted amount to its tick's decimals at
// ledger-write time (mathjs HALF-UP round: the indexer's bcmath rounds half-up,
// NOT half-even, the mode is stated in xchain-indexer/src/consensus/xchain_price.js and
// pinned by test, because a mis-read mode at the .5 boundary is a consensus
// fork), which can round a computed
// quantity UP past what the contract actually holds; on the final tranche that
// over-send exceeds custody, the whole EXECUTE reverts, and the remainder is
// stranded. Same helper and rationale as amm.js:floorToDecimals; pure exact
// string surgery on the fixed-notation decimal, deliberately not mathjs
// floor/mod (which round to the significant-digit precision, not the decimal
// grid).
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

// Decimals of the vested tick, read from the ledger snapshot. The contract
// always holds the tokens it pays out (the grant is in custody from fund()
// onward), so their token info is present whenever balances are (same
// VM_BALANCE_TOKENINFO gate getBalance rides on). Mirrors amm.js:tickDecimals.
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}

module.exports = {

    // Contract identity, read off this export at deploy and recorded on chain:
    // consensus REQUIRES name and description under CONTRACT_META_REQUIRED, and
    // meta.version must be bumped on any edit to this source (see CONTRIBUTING.md).
    meta: {
        name:        'Vesting',
        description: 'Linear token vesting with a cliff: a grantor locks tokens for a beneficiary who claims whatever has vested at the current block height, measured in blocks and truncated down, and a revocable grant lets the grantor reclaim the still-unvested remainder.',
        version:     '1.4.0'
    },

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/contract-abi.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        fund:   { summary: 'Grantor confirms custody and starts the vesting clock (BATCH after a DEPOSIT)', params: [] },
        claim:  { summary: 'Beneficiary withdraws everything vested but unclaimed', params: [] },
        cancel: { summary: 'Grantor reclaims the held deposit before the grant is funded, e.g. after fund() refused it', params: [] },
        revoke: { summary: 'Grantor reclaims the unvested portion (revocable grants only)', params: [] },
        info:   { summary: 'Read the vesting schedule and progress', params: [], view: true }
    } },

    // initialize(grantor, beneficiary, tick, total, cliffBlocks, durationBlocks, revocable)
    // `revocable` is the string "true" or "false". The vesting clock does NOT
    // start here. It starts at fund(), so there is no claimable gap before the
    // grant is actually in custody.
    initialize: function (xchain) {
        var grantor     = xchain.getInputParam(0);
        var beneficiary = xchain.getInputParam(1);
        var tick        = xchain.getInputParam(2);
        var total       = xchain.getInputParam(3);
        var cliffRaw    = xchain.getInputParam(4);
        var durationRaw = xchain.getInputParam(5);
        var revocable   = xchain.getInputParam(6);

        xchain.require(grantor && beneficiary, 'grantor, beneficiary required');
        xchain.require(tick, 'tick required');
        // Refuse 'Infinity', 'NaN' and exponent text: no deposit can ever fund such a grant,
        // so every DEPOSIT sent to it would sit unrecoverable in custody.
        requirePlainDecimal(xchain, total, 'total');
        xchain.require(xchain.math.gt(total, '0'), 'total must be positive');
        // Shape-check the schedule terms, do NOT parseInt-then-range-check them. A
        // radix-less parseInt blesses spellings that mean something else entirely
        // ('1e3' -> 1, '0x10' -> 16, '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), and both
        // params are raw deployer text measured in the same deploy that stores them.
        // A grant the deployer asked to vest over 1000 blocks via '1e3' would
        // silently install a 1-block duration, so vestedAmount() returns the whole
        // grant at the next block and the beneficiary can drain it immediately,
        // while the DEPLOY params on chain still read '1e3'. See requireIntInRange.
        requireIntInRange(xchain, cliffRaw, 0, MAX_WINDOW_BLOCKS, 'cliffBlocks');
        requireIntInRange(xchain, durationRaw, 1, MAX_WINDOW_BLOCKS, 'durationBlocks');
        var cliff    = parseInt(cliffRaw, 10);
        var duration = parseInt(durationRaw, 10);
        // cliff of 0 is allowed; a cliff longer than the whole schedule is not.
        xchain.require(cliff <= duration, 'cliffBlocks must be in [0, durationBlocks]');
        xchain.require(revocable === 'true' || revocable === 'false', 'revocable must be "true" or "false"');

        xchain.state.set('grantor', grantor);
        xchain.state.set('beneficiary', beneficiary);
        xchain.state.set('tick', tick);
        xchain.state.set('total', total);
        xchain.state.set('cliff', String(cliff));
        xchain.state.set('duration', String(duration));
        xchain.state.set('revocable', revocable);
        xchain.state.set('claimed', '0');
        xchain.state.set('status', 'INIT');
    },

    // fund(): confirm custody and start the vesting clock. BATCH after a DEPOSIT.
    // Grantor-only: it picks the clock-start block and ends the INIT window cancel() needs.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'vesting not awaiting funds');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('grantor'),
            'only the grantor can fund');

        var tick  = xchain.state.get('tick');
        var total = xchain.state.get('total');
        var held  = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        // Require custody of the full total, compared exactly: a grant armed short
        // of `total` makes the final claim's SEND exceed custody and revert.
        xchain.require(isAtLeastExact(xchain, held, total), 'insufficient deposit');
        // Refuse a total the tick's grid cannot represent: payouts floor onto the grid, so
        // one tick unit would stay in custody for good. Readable only once custody exists.
        var grid = tickDecimals(xchain, tick);
        xchain.require(isAtLeastExact(xchain, floorToDecimals(total, grid), total),
            'total is not representable at tick decimals (' + grid + ')');

        // Keep the grid so info() can floor its view without token info (read-only
        // simulations run with none).
        xchain.state.set('decimals', String(grid));
        xchain.state.set('start', String(xchain.getBlockHeight()));
        xchain.state.set('status', 'ACTIVE');
    },

    // cancel(): grantor reclaims the whole held deposit while the grant is INIT, e.g.
    // after fund() refused it (a revert does not undo a batched DEPOSIT). Terminal: a
    // grantor who was only short tops up and calls fund() again instead.
    cancel: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'vesting not cancellable');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('grantor'),
            'only the grantor can cancel');

        var tick = xchain.state.get('tick');
        var held = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        // Refuse an empty cancel so it cannot burn the INIT state for nothing.
        xchain.require(xchain.math.gt(held, '0'), 'nothing to reclaim');

        xchain.state.set('status', 'CANCELLED');
        xchain.emit.send({ destination: xchain.state.get('grantor'), tick: tick, quantity: held });
        return held;
    },

    // claim(): beneficiary withdraws everything vested-but-unclaimed so far.
    claim: function (xchain) {
        var status = xchain.state.get('status');
        xchain.require(status === 'ACTIVE' || status === 'REVOKED', 'vesting not active');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('beneficiary'),
            'only the beneficiary can claim');

        var tick      = xchain.state.get('tick');
        var vested    = vestedAmount(xchain);
        var claimed   = xchain.state.get('claimed');
        // Floor the payout onto the tick's decimal grid BEFORE it is emitted
        // (see floorToDecimals above), and advance `claimed` by the floored
        // amount actually paid, not the full-precision accrual: `claimed` then
        // always equals what the beneficiary really received, the sub-grid
        // remainder stays claimable instead of silently evaporating, and the
        // final claim pays out the accumulated dust exactly (the claims sum to
        // the grant, or to a revoked grant's on-grid frozen cap).
        var claimable = floorToDecimals(
            xchain.math.subtract(vested, claimed),
            tickDecimals(xchain, tick)
        );
        xchain.require(xchain.math.gt(claimable, '0'), 'nothing to claim');

        xchain.state.set('claimed', xchain.math.add(claimed, claimable));

        xchain.emit.send({
            destination: xchain.state.get('beneficiary'),
            tick: tick,
            quantity: claimable
        });
        return claimable;
    },

    // revoke(): grantor reclaims the still-unvested portion (revocable grants
    // only). Freezes the vested cap so the beneficiary can still claim what they
    // had already earned, but no more accrues.
    revoke: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'vesting not active');
        xchain.require(xchain.state.get('revocable') === 'true', 'grant is not revocable');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('grantor'),
            'only the grantor can revoke');

        var tick     = xchain.state.get('tick');
        var vested   = vestedAmount(xchain);
        var total    = xchain.state.get('total');
        // Floor the reclaimed payout onto the tick's decimal grid BEFORE it is
        // emitted (see floorToDecimals above): the indexer's half-up rounding
        // could otherwise round it UP past custody and revert the revoke.
        var unvested = floorToDecimals(
            xchain.math.subtract(total, vested),
            tickDecimals(xchain, tick)
        );
        xchain.require(xchain.math.gt(unvested, '0'), 'nothing to revoke (fully vested)');

        // Freeze the cap at total minus the grantor's floored payout, so the two
        // payouts sum to exactly total (a raw `vested` cap is floored again by
        // claim() and strands up to two tick units). The cap is on the grid and
        // under one tick unit above `vested`; REVOKED makes vestedAmount() return it.
        xchain.state.set('total', xchain.math.subtract(total, unvested));
        xchain.state.set('status', 'REVOKED');

        xchain.emit.send({
            destination: xchain.state.get('grantor'),
            tick: tick,
            quantity: unvested
        });
        return unvested;
    },

    info: function (xchain) {
        var status = xchain.state.get('status');
        return JSON.stringify({
            status: status,
            total: xchain.state.get('total'),
            claimed: xchain.state.get('claimed'),
            // No schedule has started in INIT or CANCELLED, so nothing is claimable.
            // Otherwise floor on the grid fund() stored, so the view shows what claim() pays.
            claimable: (status === 'INIT' || status === 'CANCELLED')
                ? '0'
                : floorToDecimals(xchain.math.subtract(vestedAmount(xchain), xchain.state.get('claimed')),
                    parseInt(xchain.state.get('decimals'), 10))
        });
    }
};

// vestedAmount(xchain): total tokens vested as of the current block.
//   - before the cliff: 0
//   - at/after full duration: the whole grant
//   - in between: total * elapsed / duration, at xchain.math's full
//     significant-digit precision. NOTE: this value is NOT on the tick's
//     decimal grid (e.g. 2.666... on a 0-decimal tick); every payout derived
//     from it is floored onto the grid at the emission sites (claim/revoke)
//     so the ledger's half-up re-normalisation can never round a payout UP
//     past custody.
// Once REVOKED, the stored `total` is the frozen cap revoke() set, returned directly.
function vestedAmount(xchain) {
    if (xchain.state.get('status') === 'REVOKED')
        return xchain.state.get('total');

    var total    = xchain.state.get('total');
    var start    = parseInt(xchain.state.get('start'));
    var cliff    = parseInt(xchain.state.get('cliff'));
    var duration = parseInt(xchain.state.get('duration'));
    var elapsed  = xchain.getBlockHeight() - start;

    if (elapsed < cliff) return '0';
    if (elapsed >= duration) return total;
    return xchain.math.divide(xchain.math.multiply(total, String(elapsed)), String(duration));
}

// Throw unless `v` is a canonical base-10 integer string within [min, max]
// inclusive. Same helper and rationale as patterns/validation.js:requireIntInRange.
//
// Validate the SHAPE of `v`, not parseInt(v): a radix-less parseInt silently
// accepts spellings a magnitude check then blesses ('1e3' -> 1, '0x10' -> 16,
// '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), so initialize() would store a schedule
// the check never truly approved and the grant would vest on terms nobody chose.
// No RegExp (the VM's determinism validator rejects RegExp in contract source), so
// this is a character walk. Inlined rather than imported: contract sources load
// as a single file into the isolated VM, which is why every adopting sibling
// (treasury.js, stableVault.js, priceBet.js) carries its own copy.
function requireIntInRange(xchain, v, min, max, name) {
    var msg = name + ' must be an integer in [' + min + ', ' + max + ']';
    var s = (typeof v === 'string') ? v : '';
    var i = (s.charAt(0) === '-') ? 1 : 0;
    var ok = s.length > i; // at least one digit after an optional sign
    for (; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch < '0' || ch > '9') { ok = false; break; }
    }
    xchain.require(ok, msg);
    var n = parseInt(s, 10);
    xchain.require(n >= min && n <= max, msg);
}

// Same helper and rationale as patterns/validation.js:requirePlainDecimal.
function requirePlainDecimal(xchain, value, label) {
    var s = String(value);
    xchain.require(s.length > 0, label + ' must be a plain decimal string');
    var dot = -1;
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '.') {
            xchain.require(dot < 0, label + ' must carry at most one decimal point');
            xchain.require(i > 0 && i < s.length - 1,
                label + ' needs digits on both sides of its decimal point');
            dot = i;
        } else {
            xchain.require(c >= '0' && c <= '9',
                label + ' must be a plain decimal: digits and one optional decimal point, ' +
                'no exponent / sign / radix prefix (got "' + s + '")');
        }
    }
}

// Return true when a >= b exactly, by the sign of the exact subtract ('-0' is zero).
// xchain.math.gte treats values within a 1e-12 relative tolerance as equal, so it
// cannot guard custody. Same helper as patterns/validation.js:isAtLeastExact.
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
