// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// escrow.js: two-party escrow with an arbiter
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
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED. See the MIT License for the full text.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// A buyer locks tokens in this contract for a seller. The funds are released to
// the seller, or refunded to the buyer, only on an authorized instruction:
//   - the buyer can release (they got what they paid for) or, after a deadline,
//     reclaim;
//   - the seller can refund (call off the deal);
//   - the arbiter can do either, to settle a dispute.
//
// CUSTODY MODEL (read this before forking)
//
// There is no msg.value on XChain. Funds enter a contract via a separate DEPOSIT
// action to the contract's own address; logic runs via EXECUTE. To make funding
// atomic, the buyer submits BOTH in one transaction with BATCH:
//
//     BATCH( DEPOSIT(this_contract, TICK, AMOUNT), EXECUTE(this_contract, "fund") )
//
// Batched sub-actions are applied in order with the deposit persisted before the
// EXECUTE runs, so fund() sees the deposited balance via getBalance(). The
// contract never trusts a caller-supplied amount; it reads its own balance.
//
// SETTLEMENT sends the contract's ENTIRE balance of the escrowed tick to the
// payee. This is deliberate: it can never leave dust stranded and removes any
// "overfund then under-pay" gap. Corollary: only ever deposit the configured
// tick; tokens of any OTHER tick sent here are not recoverable by this template.
// ---------------------------------------------------------------------------

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        fund:    { summary: 'Confirm the escrow is funded (BATCH after a DEPOSIT)', params: [] },
        release: { summary: 'Pay the seller (buyer or arbiter only)', params: [] },
        refund:  { summary: 'Return funds to the buyer (seller or arbiter only)', params: [] },
        timeout: { summary: 'Buyer reclaims after the deadline', params: [] },
        status:  { summary: 'Read the escrow status', params: [], view: true }
    } },

    // initialize(buyer, seller, arbiter, tick, amount, deadlineBlocks)
    // Sets the immutable terms at deploy time. `amount` is the minimum that must
    // be on deposit before the escrow can be funded. `deadlineBlocks` is how many
    // blocks from fund() the buyer must wait before they can unilaterally
    // reclaim. The reclaim clock deliberately does NOT start here: anchoring it
    // at deploy would let any deploy-to-funding delay eat the seller's
    // protection window, and a contract funded at/after the deploy-anchored
    // deadline would be instantly reclaimable by the buyer, bypassing the
    // seller/arbiter settlement path. fund() arms the clock when custody is
    // actually taken (same pattern as the sibling vesting template).
    initialize: function (xchain) {
        var buyer         = xchain.getInputParam(0);
        var seller        = xchain.getInputParam(1);
        var arbiter       = xchain.getInputParam(2);
        var tick          = xchain.getInputParam(3);
        var amount        = xchain.getInputParam(4);
        var deadlineBlocks = xchain.getInputParam(5);

        xchain.require(buyer && seller && arbiter, 'buyer, seller, arbiter required');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');

        // parseInt(...) > 0 rejects NaN, zero, and negatives in one check (NaN > 0 is false).
        var window = parseInt(deadlineBlocks);
        xchain.require(window > 0, 'deadlineBlocks must be a positive integer');

        xchain.state.set('buyer', buyer);
        xchain.state.set('seller', seller);
        xchain.state.set('arbiter', arbiter);
        xchain.state.set('tick', tick);
        xchain.state.set('amount', amount);
        // Persist the window; the deadline itself is anchored in fund() so the
        // buyer's reclaim clock starts when custody is taken, not at deploy.
        xchain.state.set('window', String(window));
        xchain.state.set('status', 'INIT');
    },

    // fund(): confirm the escrow is funded. Typically BATCHed after a DEPOSIT.
    // Verifies the contract actually holds at least `amount` of `tick` before
    // arming the escrow; the on-chain balance is the source of truth. Arming
    // includes the buyer's reclaim deadline: it is anchored HERE, at the block
    // custody is confirmed, so the seller always gets the full `deadlineBlocks`
    // window regardless of how long after deploy the funding lands.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'escrow not awaiting funds');

        var tick   = xchain.state.get('tick');
        var amount = xchain.state.get('amount');
        var held   = xchain.getBalance(xchain.getContractAddress(), tick) || '0';

        xchain.require(xchain.math.gte(held, amount), 'insufficient deposit');

        xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
        xchain.state.set('status', 'FUNDED');
    },

    // release(): pay the seller. Buyer (satisfied) or arbiter (dispute) only.
    release: function (xchain) {
        settle(xchain, ['buyer', 'arbiter'], 'seller', 'RELEASED', false);
    },

    // refund(): return funds to the buyer. Seller (calling it off) or arbiter only.
    refund: function (xchain) {
        settle(xchain, ['seller', 'arbiter'], 'buyer', 'REFUNDED', false);
    },

    // timeout(): buyer reclaims after the deadline if nothing was settled.
    timeout: function (xchain) {
        settle(xchain, ['buyer'], 'buyer', 'REFUNDED', true);
    },

    status: function (xchain) {
        return xchain.state.get('status');
    }
};

// settle(xchain, allowedRoles, payeeRole, terminalStatus, requireDeadline)
// Shared settlement path: authorize the caller, enforce the FUNDED guard (which
// also blocks any second settlement once the status is terminal), optionally
// gate on the deadline, then send the entire held balance to the payee and mark
// the escrow terminal. emit.send is processed atomically with this state write,
// so a later EXECUTE sees the terminal status and cannot double-pay.
function settle(xchain, allowedRoles, payeeRole, terminalStatus, requireDeadline) {
    xchain.require(xchain.state.get('status') === 'FUNDED', 'escrow not funded / already settled');

    var caller = xchain.getSourceAddress();
    var ok = false;
    for (var i = 0; i < allowedRoles.length; i++) {
        if (caller === xchain.state.get(allowedRoles[i])) { ok = true; break; }
    }
    xchain.require(ok, 'caller not authorized for this action');

    if (requireDeadline) {
        xchain.require(
            xchain.getBlockHeight() >= parseInt(xchain.state.get('deadline')),
            'deadline not reached'
        );
    }

    var tick = xchain.state.get('tick');
    var held = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
    xchain.require(xchain.math.gt(held, '0'), 'nothing to settle');

    // Mark terminal BEFORE emitting (defense in depth: the emission and this
    // write commit together, but ordering the guard first keeps intent explicit).
    xchain.state.set('status', terminalStatus);

    xchain.emit.send({
        destination: xchain.state.get(payeeRole),
        tick: tick,
        quantity: held
    });
}
