// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// englishAuction.js: ascending-bid auction with instant outbid refunds
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
// A seller locks a quantity of `itemTick` in this contract. Bidders compete in
// `bidTick`; every new bid must strictly exceed the current high bid, and the
// PREVIOUS high bidder is refunded immediately (in the same EXECUTE that placed
// the new bid) - nobody's funds sit idle mid-auction except the current leader's.
// After `deadlineBlocks` from funding, anyone can settle(): the item goes to the
// high bidder and the winning bid goes to the seller, or (no bids at all) the
// item returns to the seller.
//
// CUSTODY MODEL (read this before forking)
//
// XChain has no msg.value. The item enters via a DEPOSIT to the contract's own
// address, funded atomically with BATCH:
//
//     BATCH( DEPOSIT(auction, ITEM_TICK, itemAmount), EXECUTE(auction, "fund") )
//
// Each bid works the same way:
//
//     BATCH( DEPOSIT(auction, BID_TICK, amount), EXECUTE(auction, "bid") )
//
// bid() never trusts a caller-supplied amount. Because every out-bid deposit is
// refunded in the SAME execution that supersedes it, the contract's bidTick
// balance is always exactly the current high bid; a new bid's size is read as
// the growth in that balance since the last bid (balance - highBid), the same
// delta-accounting idiom the crowdsale template uses for buy().
// ---------------------------------------------------------------------------

// Upper bound for the deadline constructor param. A sanity ceiling, not a
// protocol limit: fund() adds this window to a plain JS block height, so the
// point is to keep a fat-fingered constructor term inside the exactly-
// representable integer range rather than to constrain a real auction.
// MAX_WINDOW_BLOCKS is 1e6 blocks (~19 years at 10-minute blocks), the same
// ceiling escrow.js, treasury.js and patterns/validation.js use.
var MAX_WINDOW_BLOCKS = 1000000;

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        fund:   { summary: 'Seller deposits the item (BATCH after a DEPOSIT)', params: [] },
        bid:    { summary: 'Place a strictly-higher bid (BATCH after a DEPOSIT); outbids the prior leader who is refunded instantly', params: [] },
        settle: { summary: 'After the deadline: pay the item to the high bidder and the bid to the seller (or return the item, if unsold)', params: [] },
        cancel: { summary: 'Seller reclaims the item before any bid has been placed', params: [] },
        info:   { summary: 'Read the auction status and current high bid', params: [], view: true }
    } },

    // initialize(seller, itemTick, itemAmount, bidTick, minBid, deadlineBlocks)
    // Sets the immutable terms at deploy time. The bidding clock does NOT start
    // here - it starts at fund(), when the item is actually in custody, same
    // deadline-anchoring rationale as the sibling escrow/vesting templates.
    initialize: function (xchain) {
        var seller      = xchain.getInputParam(0);
        var itemTick    = xchain.getInputParam(1);
        var itemAmount  = xchain.getInputParam(2);
        var bidTick     = xchain.getInputParam(3);
        var minBid      = xchain.getInputParam(4);
        var deadline    = xchain.getInputParam(5);

        xchain.require(seller, 'seller required');
        xchain.require(itemTick && bidTick, 'itemTick, bidTick required');
        xchain.require(itemTick !== bidTick, 'itemTick and bidTick must differ');
        xchain.require(itemAmount && xchain.math.gt(itemAmount, '0'), 'itemAmount must be positive');
        xchain.require(minBid && xchain.math.gt(minBid, '0'), 'minBid must be positive');

        // Shape-check the window, do NOT parseInt-then-range-check it. A radix-less
        // parseInt blesses spellings that mean something else entirely ('1e3' -> 1,
        // '0x10' -> 16, '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), and deadlineBlocks is
        // raw deployer text measured in the same deploy that stores it. A seller
        // reading '1e3' off the DEPLOY action believes they armed a 1000-block
        // auction while initialize() armed a 1-block one, so bidding closes before
        // anyone can bid - and every bid that then reverts on the deadline guard
        // strands its batched DEPOSIT. See requireIntInRange.
        requireIntInRange(xchain, deadline, 1, MAX_WINDOW_BLOCKS, 'deadlineBlocks');
        var window = parseInt(deadline, 10);

        xchain.state.set('seller', seller);
        xchain.state.set('itemTick', itemTick);
        xchain.state.set('itemAmount', itemAmount);
        xchain.state.set('bidTick', bidTick);
        xchain.state.set('minBid', minBid);
        xchain.state.set('window', String(window));
        xchain.state.set('highBid', '0');
        xchain.state.set('status', 'INIT');
    },

    // fund(): seller deposits the item. Verifies custody, then arms the
    // bidding window from THIS block.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'auction not awaiting the item');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('seller'), 'only the seller can fund');

        var itemTick   = xchain.state.get('itemTick');
        var itemAmount = xchain.state.get('itemAmount');
        var held       = xchain.getBalance(xchain.getContractAddress(), itemTick) || '0';
        xchain.require(xchain.math.gte(held, itemAmount), 'insufficient item deposit');

        xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
        xchain.state.set('status', 'ACTIVE');
    },

    // bid(): place a strictly-higher bid. BATCH after a DEPOSIT of bidTick.
    // The prior high bidder (if any) is refunded in this same execution.
    bid: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'auction not active');
        xchain.require(xchain.getBlockHeight() < parseInt(xchain.state.get('deadline')), 'bidding closed (deadline passed); call settle()');

        var caller = xchain.getSourceAddress();
        var prevBidder = xchain.state.get('highBidder');
        // Deliberately simple: an existing leader cannot raise their own bid,
        // because doing so would refund-then-replace their own stake with just
        // the marginal deposit (the delta-accounting below only ever measures
        // growth since the last bid, not a running total per bidder). Forcing a
        // fresh address for every raise keeps that accounting exact. See the
        // README's "Known limitations".
        xchain.require(caller !== prevBidder, 'you are already the high bidder');

        var bidTick  = xchain.state.get('bidTick');
        var held     = xchain.getBalance(xchain.getContractAddress(), bidTick) || '0';
        var highBid  = xchain.state.get('highBid');
        var newBid   = xchain.math.subtract(held, highBid);

        xchain.require(xchain.math.gt(newBid, '0'), 'no bid received (DEPOSIT in the same BATCH)');
        xchain.require(xchain.math.gte(newBid, xchain.state.get('minBid')), 'bid below the minimum');
        xchain.require(xchain.math.gt(newBid, highBid), 'bid must exceed the current high bid');

        if (prevBidder) {
            xchain.emit.send({ destination: prevBidder, tick: bidTick, quantity: highBid });
        }

        xchain.state.set('highBid', newBid);
        xchain.state.set('highBidder', caller);
    },

    // settle(): after the deadline, pay out the item and the winning bid (or
    // return the item to the seller if nobody bid). Callable by anyone.
    settle: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'auction not active');
        xchain.require(xchain.getBlockHeight() >= parseInt(xchain.state.get('deadline')), 'deadline not reached');

        var itemTick   = xchain.state.get('itemTick');
        var itemAmount = xchain.state.get('itemAmount');
        var highBidder = xchain.state.get('highBidder');

        if (highBidder) {
            xchain.state.set('status', 'SOLD');
            xchain.emit.send({ destination: highBidder, tick: itemTick, quantity: itemAmount });
            xchain.emit.send({ destination: xchain.state.get('seller'), tick: xchain.state.get('bidTick'), quantity: xchain.state.get('highBid') });
        } else {
            xchain.state.set('status', 'UNSOLD');
            xchain.emit.send({ destination: xchain.state.get('seller'), tick: itemTick, quantity: itemAmount });
        }
    },

    // cancel(): seller reclaims the item before any bid has landed.
    cancel: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'auction not active');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('seller'), 'only the seller can cancel');
        xchain.require(!xchain.state.get('highBidder'), 'cannot cancel: a bid has already been placed');

        xchain.state.set('status', 'CANCELLED');
        xchain.emit.send({
            destination: xchain.state.get('seller'),
            tick: xchain.state.get('itemTick'),
            quantity: xchain.state.get('itemAmount')
        });
    },

    info: function (xchain) {
        return JSON.stringify({
            status: xchain.state.get('status'),
            highBid: xchain.state.get('highBid'),
            highBidder: xchain.state.get('highBidder') || null,
            minBid: xchain.state.get('minBid'),
            deadline: xchain.state.get('deadline') || null
        });
    }
};

// Throw unless `v` is a canonical base-10 integer string within [min, max]
// inclusive. Same helper and rationale as patterns/validation.js:requireIntInRange.
//
// Validate the SHAPE of `v`, not parseInt(v): a radix-less parseInt silently
// accepts spellings a magnitude check then blesses ('1e3' -> 1, '0x10' -> 16,
// '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), so initialize() would store a window the
// check never truly approved and the auction would run on terms nobody chose.
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
