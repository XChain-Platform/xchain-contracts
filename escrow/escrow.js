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
//   - the buyer can release (they got what they paid for), cancel before the
//     escrow is funded, or, after a deadline, reclaim;
//   - the seller can refund (call off the deal);
//   - the arbiter can do either, to settle a dispute.
//
// CUSTODY MODEL (read this before forking)
//
// There is no msg.value on XChain. Funds enter a contract via a separate DEPOSIT
// action to the contract's own address; logic runs via EXECUTE. To fund and act
// in one transaction, the buyer submits BOTH with BATCH:
//
//     BATCH( DEPOSIT(this_contract, TICK, AMOUNT), EXECUTE(this_contract, "fund") )
//
// Batched sub-actions are applied in order with the deposit persisted before the
// EXECUTE runs, so fund() sees the deposited balance via getBalance(). They still
// settle independently: a BATCH is NOT atomic, so an EXECUTE that reverts does not
// undo the DEPOSIT ahead of it and the funds stay in the contract's custody. The
// contract never trusts a caller-supplied amount; it reads its own balance.
//
// SETTLEMENT sends the contract's ENTIRE balance of the escrowed tick to the
// payee. This is deliberate: it can never leave dust stranded and removes any
// "overfund then under-pay" gap. Corollary: only ever deposit the configured
// tick; tokens of any OTHER tick sent here are not recoverable by this template.
// ---------------------------------------------------------------------------

// Upper bound for the deadline constructor param. A sanity ceiling, not a
// protocol limit: fund() adds this window to a plain JS block height, so the
// point is to keep a fat-fingered constructor term inside the exactly-
// representable integer range rather than to constrain a real escrow.
// MAX_WINDOW_BLOCKS is 1e6 blocks (~19 years at 10-minute blocks), the same
// ceiling treasury.js, priceBet.js and patterns/validation.js use.
var MAX_WINDOW_BLOCKS = 1000000;

module.exports = {

    // Contract identity, read off this export at deploy and recorded on chain:
    // consensus REQUIRES name and description under CONTRACT_META_REQUIRED, and
    // meta.version must be bumped on any edit to this source (see CONTRIBUTING.md).
    meta: {
        name:        'Escrow',
        description: 'Two-party escrow with an arbiter: a buyer deposits tokens for a seller, and the funds are released, refunded, or reclaimed after a deadline only on an authorized instruction from the buyer, the seller, or the arbiter.',
        version:     '1.3.0'
    },

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/contract-abi.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        fund:    { summary: 'Confirm the escrow is funded (BATCH after a DEPOSIT)', params: [] },
        release: { summary: 'Pay the seller (buyer or arbiter only)', params: [] },
        refund:  { summary: 'Return funds to the buyer (seller or arbiter only)', params: [] },
        timeout: { summary: 'Buyer reclaims after the deadline', params: [] },
        cancel:  { summary: 'Buyer withdraws a deposit before the escrow is funded', params: [] },
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
        requirePlainDecimal(xchain, amount, 'amount');
        xchain.require(xchain.math.gt(amount, '0'), 'amount must be positive');

        // Shape-check the window, do NOT parseInt-then-range-check it. A radix-less
        // parseInt blesses spellings that mean something else entirely ('1e9' -> 1,
        // '0x10' -> 16, '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), and deadlineBlocks is
        // raw deployer text measured in the same deploy that stores it. A seller
        // reading '1e9' off the DEPLOY action sees a ~19,000-year protection window
        // while initialize() installs a 1-block one, so the buyer can fund(), take
        // delivery, and reclaim the entire held balance via timeout() one block
        // later, bypassing the seller/arbiter settlement path this template exists
        // to provide. See requireIntInRange.
        requireIntInRange(xchain, deadlineBlocks, 1, MAX_WINDOW_BLOCKS, 'deadlineBlocks');
        var window = parseInt(deadlineBlocks, 10);

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

        // Require custody of the full amount, compared exactly, so the payee is never
        // settled a dust margin short of the agreed terms.
        xchain.require(isAtLeastExact(xchain, held, amount), 'insufficient deposit');

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

    // cancel(): buyer withdraws a deposit while the escrow is still INIT, for
    // example after an underfunded or mistaken DEPOSIT that fund() rejected.
    // Returns the whole held balance and closes the escrow.
    cancel: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'escrow not awaiting funds');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('buyer'), 'caller not authorized for this action');

        var tick = xchain.state.get('tick');
        var held = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        xchain.require(xchain.math.gt(held, '0'), 'nothing to cancel');

        xchain.state.set('status', 'CANCELLED');

        xchain.emit.send({
            destination: xchain.state.get('buyer'),
            tick: tick,
            quantity: held
        });
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

// Require a plain fixed-notation decimal: digits and at most one interior decimal
// point, no exponent, sign or radix prefix. Same helper as
// cardDispenser.js:requirePlainDecimal, inlined for the single-file VM load.
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

// Throw unless `v` is a canonical base-10 integer string within [min, max]
// inclusive. Same helper and rationale as patterns/validation.js:requireIntInRange.
//
// Validate the SHAPE of `v`, not parseInt(v): a radix-less parseInt silently
// accepts spellings a magnitude check then blesses ('1e9' -> 1, '0x10' -> 16,
// '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), so initialize() would store a window the
// check never truly approved and the escrow would run on terms nobody chose.
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
