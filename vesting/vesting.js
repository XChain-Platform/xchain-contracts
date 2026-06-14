// SPDX-License-Identifier: MIT
//
// XChain Platform — Contract Template Library
// vesting.js — linear token vesting with a cliff and optional revocation
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
// Time is measured in BLOCKS, not wall-clock — XChain contracts have no clock,
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
// amount. Deposit EXACTLY `total` of the configured tick — surplus, or any other
// tick, is not recoverable by this template.
// ---------------------------------------------------------------------------

module.exports = {

    // initialize(grantor, beneficiary, tick, total, cliffBlocks, durationBlocks, revocable)
    // `revocable` is the string "true" or "false". The vesting clock does NOT
    // start here — it starts at fund(), so there is no claimable gap before the
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

    // fund() — confirm custody and start the clock. BATCH after a DEPOSIT.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'vesting not awaiting funds');

        var tick  = xchain.state.get('tick');
        var total = xchain.state.get('total');
        var held  = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        xchain.require(xchain.math.gte(held, total), 'insufficient deposit');

        xchain.state.set('start', String(xchain.getBlockHeight()));
        xchain.state.set('status', 'ACTIVE');
    },

    // claim() — beneficiary withdraws everything vested-but-unclaimed so far.
    claim: function (xchain) {
        var status = xchain.state.get('status');
        xchain.require(status === 'ACTIVE' || status === 'REVOKED', 'vesting not active');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('beneficiary'),
            'only the beneficiary can claim');

        var vested    = vestedAmount(xchain);
        var claimed   = xchain.state.get('claimed');
        var claimable = xchain.math.subtract(vested, claimed);
        xchain.require(xchain.math.gt(claimable, '0'), 'nothing to claim');

        xchain.state.set('claimed', xchain.math.add(claimed, claimable));

        xchain.emit.send({
            destination: xchain.state.get('beneficiary'),
            tick: xchain.state.get('tick'),
            quantity: claimable
        });
        return claimable;
    },

    // revoke() — grantor reclaims the still-unvested portion (revocable grants
    // only). Freezes the vested cap so the beneficiary can still claim what they
    // had already earned, but no more accrues.
    revoke: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'vesting not active');
        xchain.require(xchain.state.get('revocable') === 'true', 'grant is not revocable');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('grantor'),
            'only the grantor can revoke');

        var vested   = vestedAmount(xchain);
        var total    = xchain.state.get('total');
        var unvested = xchain.math.subtract(total, vested);
        xchain.require(xchain.math.gt(unvested, '0'), 'nothing to revoke (fully vested)');

        // Freeze the cap at what had vested; status REVOKED makes vestedAmount()
        // return this frozen value instead of continuing to accrue.
        xchain.state.set('total', vested);
        xchain.state.set('status', 'REVOKED');

        xchain.emit.send({
            destination: xchain.state.get('grantor'),
            tick: xchain.state.get('tick'),
            quantity: unvested
        });
        return unvested;
    },

    // info() — read-only snapshot for UIs.
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

// vestedAmount(xchain) — total tokens vested as of the current block.
//   - before the cliff: 0
//   - at/after full duration: the whole grant
//   - in between: total * elapsed / duration (math.divide truncates, so this
//     rounds DOWN — the contract never over-pays; the remainder is released
//     exactly at full vesting)
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
