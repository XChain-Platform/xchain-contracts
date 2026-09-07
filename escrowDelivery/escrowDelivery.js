// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// escrowDelivery.js: escrow that releases itself on a delivery attestation
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
// Same custody model as the sibling `escrow` template (buyer deposits, arbiter
// can settle disputes, buyer can time out), plus one more path: ANYONE can
// point the contract at a carrier tracking URL, and if the tracking page's
// body contains the configured delivery marker, the escrow releases itself to
// the seller with no human settlement call. This is the pattern for
// "the shipment scanned as delivered -> pay the seller" without a trusted
// human in the loop for the happy path.
//
// A contract cannot fetch a URL directly (the sandbox strips fetch/Date/
// timers so every validator agrees bit-for-bit). It asks the network via the
// attestation framework instead - see the `urlOracle` template for the
// request/callback round trip in isolation. This template composes that
// round trip with `escrow`'s custody model:
//
//   1. requestDelivery(trackingUrl) -> emits an ATTEST http_get request,
//      remembers its request_id.
//   2. (off-chain) N providers GET the URL, sign the body, the indexer
//      anchors the agreed response on-chain.
//   3. onDelivery(request_id) -> the indexer calls this back. If the settled
//      body contains `deliveryMarker`, the ENTIRE held balance pays the
//      seller and the escrow goes terminal. Otherwise the check is a no-op:
//      pending clears and anyone can retry later (the courier hasn't
//      scanned it yet).
//
// The manual paths from `escrow` (release/refund/timeout) stay available as
// a fallback: a false negative (marker text changes, tracking page moves) or
// a genuine dispute still resolves through the buyer/seller/arbiter/deadline
// paths, not just automation.
//
// CUSTODY MODEL: identical to `escrow` (read that template first). Fund in one
// transaction with BATCH(DEPOSIT(this, TICK, AMOUNT), EXECUTE(this, "fund")).
// A BATCH is NOT atomic: a fund() that reverts leaves the DEPOSIT ahead of it
// standing in custody.
// Settlement always sends the contract's ENTIRE balance of the escrowed tick.
// ---------------------------------------------------------------------------

// Upper bound for the deadline constructor param. A sanity ceiling, not a
// protocol limit: fund() adds this window to a plain JS block height, so the
// point is to keep a fat-fingered constructor term inside the exactly-
// representable integer range rather than to constrain a real escrow.
// MAX_WINDOW_BLOCKS is 1e6 blocks (~19 years at 10-minute blocks), the same
// ceiling escrow.js, treasury.js and patterns/validation.js use.
var MAX_WINDOW_BLOCKS = 1000000;

module.exports = {

    abi: { version: 1, methods: {
        fund:            { summary: 'Confirm the escrow is funded (BATCH after a DEPOSIT)', params: [] },
        requestDelivery: { summary: 'Ask the network to check a tracking URL for the delivery marker', params: [ { name: 'trackingUrl', type: 'string' } ] },
        onDelivery:      { summary: 'Callback: auto-releases to seller if the tracking body matched (not user-callable)', params: [ { name: 'requestId', type: 'string' } ] },
        release:         { summary: 'Pay the seller (buyer or arbiter only)', params: [] },
        refund:          { summary: 'Return funds to the buyer (seller or arbiter only)', params: [] },
        timeout:         { summary: 'Buyer reclaims after the deadline', params: [] },
        status:          { summary: 'Read the escrow status', params: [], view: true }
    } },

    // initialize(buyer, seller, arbiter, tick, amount, deadlineBlocks, deliveryMarker)
    // Same terms as `escrow`, plus `deliveryMarker`: a substring that must
    // appear in the tracking URL's settled body for onDelivery to treat the
    // shipment as delivered (e.g. '"status":"delivered"' or 'Delivered').
    // Kept as a plain substring match, not JSON parsing, so this works
    // against any carrier's tracking page without coupling to one schema.
    initialize: function (xchain) {
        var buyer          = xchain.getInputParam(0);
        var seller         = xchain.getInputParam(1);
        var arbiter        = xchain.getInputParam(2);
        var tick           = xchain.getInputParam(3);
        var amount         = xchain.getInputParam(4);
        var deadlineBlocks = xchain.getInputParam(5);
        var deliveryMarker = xchain.getInputParam(6);

        xchain.require(buyer && seller && arbiter, 'buyer, seller, arbiter required');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        xchain.require(typeof deliveryMarker === 'string' && deliveryMarker.length > 0, 'deliveryMarker required');

        // Shape-check the window, do NOT parseInt-then-range-check it. A radix-less
        // parseInt blesses spellings that mean something else entirely ('1e9' -> 1,
        // '0x10' -> 16, '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), and deadlineBlocks is
        // raw deployer text measured in the same deploy that stores it. A seller
        // reading '1e9' off the DEPLOY action sees a ~19,000-year protection window
        // while initialize() installs a 1-block one, so the buyer can fund(), take
        // delivery, and reclaim the entire held balance via timeout() one block
        // later, bypassing the seller/arbiter settlement path this template exists
        // to provide. Same hazard, same helper and same ceiling as escrow.js.
        requireIntInRange(xchain, deadlineBlocks, 1, MAX_WINDOW_BLOCKS, 'deadlineBlocks');
        var window = parseInt(deadlineBlocks, 10);

        xchain.state.set('buyer', buyer);
        xchain.state.set('seller', seller);
        xchain.state.set('arbiter', arbiter);
        xchain.state.set('tick', tick);
        xchain.state.set('amount', amount);
        xchain.state.set('window', String(window));
        xchain.state.set('deliveryMarker', deliveryMarker);
        xchain.state.set('status', 'INIT');
    },

    // fund(): identical to `escrow`. Arms the escrow off the on-chain balance
    // (never a caller-supplied amount) and anchors the reclaim deadline here,
    // at the block custody is actually taken.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'escrow not awaiting funds');

        var tick   = xchain.state.get('tick');
        var amount = xchain.state.get('amount');
        var held   = xchain.getBalance(xchain.getContractAddress(), tick) || '0';

        xchain.require(xchain.math.gte(held, amount), 'insufficient deposit');

        xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
        xchain.state.set('status', 'FUNDED');
    },

    // requestDelivery(trackingUrl): ask the network to fetch the carrier's
    // tracking page. Permissionless like a liquidation call - anyone can
    // trigger a check (buyer chasing their order, seller proving they
    // shipped, arbiter investigating), and the check itself can't move funds
    // on its own; only a matching onDelivery body can.
    requestDelivery: function (xchain) {
        xchain.require(xchain.state.get('status') === 'FUNDED', 'escrow not funded');
        xchain.require(!xchain.state.get('pending'), 'a delivery check is already pending');

        var trackingUrl = xchain.getInputParam(0);
        xchain.require(typeof trackingUrl === 'string' && trackingUrl.length > 0, 'trackingUrl required');

        var requestId = xchain.attestation.request(
            'http_get',
            trackingUrl,
            'onDelivery',
            [],
            { redundancy: 3, deadlineBlocks: 20 }
        );

        xchain.state.set('pending', requestId);
        xchain.log('delivery check requested', trackingUrl, requestId);
        return requestId;
    },

    // onDelivery(request_id): the indexer's callback once the tracking check
    // settles. Pinned to the outstanding request (unlike the urlOracle
    // teaching example, which documents this as a known gap) so a stale
    // settled response for some earlier request can't be replayed to force
    // a release. If the escrow already settled through another path (e.g.
    // an arbiter resolved a dispute while the check was in flight), this is
    // a harmless no-op guarded by the FUNDED check.
    onDelivery: function (xchain) {
        var requestId = xchain.getInputParam(0);
        xchain.require(requestId === xchain.state.get('pending'), 'not the outstanding delivery request');

        if (xchain.state.get('status') !== 'FUNDED') {
            xchain.state.delete('pending');
            return 'ignored: escrow already settled';
        }

        var resp = xchain.attestation.getResponse(requestId);
        xchain.require(resp !== null, 'no response yet');

        // A failed/undelivered check is not fatal: clear pending so anyone
        // can call requestDelivery again once the shipment actually moves.
        if (resp.status !== 'ok' || resp.payload.indexOf(xchain.state.get('deliveryMarker')) === -1) {
            xchain.state.delete('pending');
            xchain.log('delivery not confirmed', requestId);
            return 'not delivered yet';
        }

        xchain.state.delete('pending');
        payout(xchain, 'seller', 'DELIVERED');
        xchain.log('delivery confirmed, released to seller', requestId);
        return 'delivered';
    },

    // release(): manual fallback (buyer satisfied, or arbiter dispute) - same
    // authorization as `escrow`, for when the tracking marker never matches
    // (wrong marker, carrier page redesign) but the goods did arrive.
    release: function (xchain) {
        settle(xchain, ['buyer', 'arbiter'], 'seller', 'RELEASED', false);
    },

    // refund(): seller calls off the deal, or arbiter rules for the buyer.
    refund: function (xchain) {
        settle(xchain, ['seller', 'arbiter'], 'buyer', 'REFUNDED', false);
    },

    // timeout(): buyer reclaims after the deadline if nothing ever settled -
    // the shipment never scanned as delivered and nobody intervened.
    timeout: function (xchain) {
        settle(xchain, ['buyer'], 'buyer', 'REFUNDED', true);
    },

    status: function (xchain) {
        return xchain.state.get('status');
    }
};

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
// (escrow.js, treasury.js, stableVault.js, priceBet.js) carries its own copy.
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

// payout(xchain, payeeRole, terminalStatus): the shared settlement action -
// mark terminal, then send the entire held balance to the named role. Used
// both by the automated onDelivery path (no caller authorization: the
// attestation itself is the authorization) and by settle() below (which adds
// caller authorization first for the manual paths).
function payout(xchain, payeeRole, terminalStatus) {
    var tick = xchain.state.get('tick');
    var held = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
    xchain.require(xchain.math.gt(held, '0'), 'nothing to settle');

    // Mark terminal BEFORE emitting: the write and the emission commit
    // together, so a second settlement attempt - manual or automated - sees
    // the terminal status and cannot double-pay.
    xchain.state.set('status', terminalStatus);

    xchain.emit.send({
        destination: xchain.state.get(payeeRole),
        tick: tick,
        quantity: held
    });
}

// settle(xchain, allowedRoles, payeeRole, terminalStatus, requireDeadline)
// Manual settlement path: authorize the caller against the stored roles
// (also blocks any second settlement once the status is terminal, since only
// FUNDED escrows are settleable), optionally gate on the deadline, then hand
// off to payout().
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

    payout(xchain, payeeRole, terminalStatus);
}
