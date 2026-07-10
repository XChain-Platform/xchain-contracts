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
// address; fund it atomically with BATCH:
//
//     BATCH( DEPOSIT(vesting, TICK, TOTAL), EXECUTE(vesting, "fund") )
//
// fund() verifies the contract actually holds `total` (via getBalance) and starts
// the vesting clock from that block. The contract never trusts a caller-supplied
// amount. Deposit EXACTLY `total` of the configured tick; surplus, or any other
// tick, is not recoverable by this template.
// ---------------------------------------------------------------------------

// Quantise a computed amount DOWN onto a tick's decimal grid before emitting it.
// The indexer normalises every emitted amount to its tick's decimals at
// ledger-write time (mathjs half-even round), which can round a computed
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

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        fund:   { summary: 'Confirm custody and start the vesting clock (BATCH after a DEPOSIT)', params: [] },
        claim:  { summary: 'Beneficiary withdraws everything vested but unclaimed', params: [] },
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
        var cliff       = parseInt(xchain.getInputParam(4));
        var duration    = parseInt(xchain.getInputParam(5));
        var revocable   = xchain.getInputParam(6);

        xchain.require(grantor && beneficiary, 'grantor, beneficiary required');
        xchain.require(tick, 'tick required');
        xchain.require(total && xchain.math.gt(total, '0'), 'total must be positive');
        xchain.require(duration > 0, 'durationBlocks must be a positive integer');
        // cliff of 0 is allowed; a cliff longer than the whole schedule is not.
        xchain.require(cliff >= 0 && cliff <= duration, 'cliffBlocks must be in [0, durationBlocks]');
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
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'vesting not awaiting funds');

        var tick  = xchain.state.get('tick');
        var total = xchain.state.get('total');
        var held  = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        xchain.require(xchain.math.gte(held, total), 'insufficient deposit');

        xchain.state.set('start', String(xchain.getBlockHeight()));
        xchain.state.set('status', 'ACTIVE');
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
        // final claim pays out the accumulated dust exactly (total custody is
        // conserved to within one tick unit).
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
        // emitted (see floorToDecimals above): the indexer's half-even rounding
        // could otherwise round it UP past custody and revert the revoke. The
        // sub-grid fraction stays in custody for the beneficiary's final claim.
        var unvested = floorToDecimals(
            xchain.math.subtract(total, vested),
            tickDecimals(xchain, tick)
        );
        xchain.require(xchain.math.gt(unvested, '0'), 'nothing to revoke (fully vested)');

        // Freeze the cap at what had vested; status REVOKED makes vestedAmount()
        // return this frozen value instead of continuing to accrue.
        xchain.state.set('total', vested);
        xchain.state.set('status', 'REVOKED');

        xchain.emit.send({
            destination: xchain.state.get('grantor'),
            tick: tick,
            quantity: unvested
        });
        return unvested;
    },

    info: function (xchain) {
        return JSON.stringify({
            status: xchain.state.get('status'),
            total: xchain.state.get('total'),
            claimed: xchain.state.get('claimed'),
            claimable: xchain.state.get('status') === 'INIT'
                ? '0'
                : xchain.math.subtract(vestedAmount(xchain), xchain.state.get('claimed'))
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
//     so the ledger's half-even re-normalisation can never round a payout UP
//     past custody.
// Once REVOKED, the stored `total` is the frozen vested cap, returned directly.
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
