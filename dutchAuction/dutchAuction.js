// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// dutchAuction.js: descending-price auction, first acceptance wins
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
// A seller locks a quantity of `itemTick` in this contract. The asking price
// starts at `startPrice` and falls linearly, block by block, to a floor of
// `endPrice` over `durationBlocks`; it stays pinned at the floor forever after.
// There is no bidding: the FIRST buyer willing to pay the price in effect at
// the block their transaction lands gets the item, at that price. Unlike the
// English auction, this template has no losing bidders to refund - only ever
// one buy() succeeds, and it settles the whole sale in a single call.
//
// CUSTODY MODEL (read this before forking)
//
// XChain has no msg.value. The item enters via a DEPOSIT to the contract's own
// address, funded atomically with BATCH:
//
//     BATCH( DEPOSIT(auction, ITEM_TICK, itemAmount), EXECUTE(auction, "fund") )
//
// A buy attempt works the same way - deposit at least the current price, then
// execute buy() in the SAME transaction:
//
//     BATCH( DEPOSIT(auction, BID_TICK, quotedPrice), EXECUTE(auction, "buy") )
//
// buy() never trusts a caller-supplied amount: it reads the contract's actual
// bidTick balance and compares it to the price in effect this block. Anything
// deposited above that price is refunded to the buyer in the same execution, so
// a slightly-stale quote (price ticked down between the caller reading it and
// the transaction landing) never overcharges - it can only ever undercharge if
// the deposit falls short, in which case buy() reverts and the deposit sits in
// the contract until either a corrected buy() or the seller's cancel() (which
// only ever returns the ITEM, not stray bidTick - see Known limitations).
// ---------------------------------------------------------------------------

// Quantise a computed amount DOWN onto a tick's decimal grid before emitting it.
// The indexer normalises every emitted amount to its tick's decimals at ledger-
// write time (mathjs half-even round), which can round a computed quantity UP
// past what the contract actually holds. Flooring the asking price onto
// bidTick's grid before using it as both the "required minimum" and the
// "amount sent to the seller" keeps both checks and both emissions exact. Same
// helper and rationale as vesting.js/crowdsale.js/amm.js:floorToDecimals.
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

// Decimals of the bidTick, read from the ledger snapshot. Mirrors
// vesting.js/amm.js:tickDecimals; requires the token info to be readable
// (same VM_BALANCE_TOKENINFO gate getBalance rides on).
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
        fund:   { summary: 'Seller deposits the item and starts the price clock (BATCH after a DEPOSIT)', params: [] },
        buy:    { summary: 'Pay the current asking price (BATCH after a DEPOSIT); first caller wins the item', params: [] },
        cancel: { summary: 'Seller reclaims the item before any purchase', params: [] },
        info:   { summary: 'Read the auction status and the current asking price', params: [], view: true }
    } },

    // initialize(seller, itemTick, itemAmount, bidTick, startPrice, endPrice, durationBlocks)
    // Sets the immutable terms at deploy time. The price clock does NOT start
    // here - it starts at fund(), when the item is actually in custody, same
    // deadline-anchoring rationale as the sibling escrow/vesting/englishAuction
    // templates.
    initialize: function (xchain) {
        var seller     = xchain.getInputParam(0);
        var itemTick   = xchain.getInputParam(1);
        var itemAmount = xchain.getInputParam(2);
        var bidTick    = xchain.getInputParam(3);
        var startPrice = xchain.getInputParam(4);
        var endPrice   = xchain.getInputParam(5);
        var duration   = parseInt(xchain.getInputParam(6));

        xchain.require(seller, 'seller required');
        xchain.require(itemTick && bidTick, 'itemTick, bidTick required');
        xchain.require(itemTick !== bidTick, 'itemTick and bidTick must differ');
        xchain.require(itemAmount && xchain.math.gt(itemAmount, '0'), 'itemAmount must be positive');
        xchain.require(endPrice && xchain.math.gt(endPrice, '0'), 'endPrice must be positive');
        xchain.require(startPrice && xchain.math.gt(startPrice, endPrice), 'startPrice must exceed endPrice');
        xchain.require(duration > 0, 'durationBlocks must be a positive integer');

        xchain.state.set('seller', seller);
        xchain.state.set('itemTick', itemTick);
        xchain.state.set('itemAmount', itemAmount);
        xchain.state.set('bidTick', bidTick);
        xchain.state.set('startPrice', startPrice);
        xchain.state.set('endPrice', endPrice);
        xchain.state.set('duration', String(duration));
        xchain.state.set('status', 'INIT');
    },

    // fund(): seller deposits the item. Verifies custody, then starts the
    // price clock from THIS block.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'auction not awaiting the item');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('seller'), 'only the seller can fund');

        var itemTick   = xchain.state.get('itemTick');
        var itemAmount = xchain.state.get('itemAmount');
        var held       = xchain.getBalance(xchain.getContractAddress(), itemTick) || '0';
        xchain.require(xchain.math.gte(held, itemAmount), 'insufficient item deposit');

        xchain.state.set('start', String(xchain.getBlockHeight()));
        xchain.state.set('status', 'ACTIVE');
    },

    // buy(): pay the current asking price. BATCH after a DEPOSIT of bidTick
    // (at least the current price - any excess is refunded in this same call).
    buy: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'auction not active');

        var bidTick = xchain.state.get('bidTick');
        var price   = floorToDecimals(currentPrice(xchain), tickDecimals(xchain, bidTick));
        var held    = xchain.getBalance(xchain.getContractAddress(), bidTick) || '0';

        xchain.require(xchain.math.gte(held, price), 'insufficient payment for the current price (' + price + ')');

        var caller = xchain.getSourceAddress();
        var excess = xchain.math.subtract(held, price);

        // Mark terminal BEFORE emitting: the item and the payment settle in
        // one execution, so no second buy() can ever land on a sold auction.
        xchain.state.set('status', 'SOLD');
        xchain.state.set('soldPrice', price);
        xchain.state.set('buyer', caller);

        xchain.emit.send({ destination: caller, tick: xchain.state.get('itemTick'), quantity: xchain.state.get('itemAmount') });
        xchain.emit.send({ destination: xchain.state.get('seller'), tick: bidTick, quantity: price });
        if (xchain.math.gt(excess, '0')) {
            xchain.emit.send({ destination: caller, tick: bidTick, quantity: excess });
        }
    },

    // cancel(): seller reclaims the item before any purchase.
    cancel: function (xchain) {
        xchain.require(xchain.state.get('status') === 'ACTIVE', 'auction not active');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('seller'), 'only the seller can cancel');

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
            currentPrice: xchain.state.get('status') === 'ACTIVE' ? currentPrice(xchain) : null,
            startPrice: xchain.state.get('startPrice'),
            endPrice: xchain.state.get('endPrice')
        });
    }
};

// currentPrice(xchain): the asking price as of the current block.
//   - before/at start: startPrice
//   - at/after start + duration: endPrice (floor, held forever after)
//   - in between: startPrice - (startPrice - endPrice) * elapsed / duration, at
//     xchain.math's full significant-digit precision. NOT necessarily on
//     bidTick's decimal grid - callers floor it via floorToDecimals before using
//     it as a required amount or an emitted quantity (see buy() above).
function currentPrice(xchain) {
    var start    = parseInt(xchain.state.get('start'));
    var duration = parseInt(xchain.state.get('duration'));
    var elapsed  = xchain.getBlockHeight() - start;
    var startPrice = xchain.state.get('startPrice');
    var endPrice   = xchain.state.get('endPrice');

    if (elapsed >= duration) return endPrice;

    var drop = xchain.math.subtract(startPrice, endPrice);
    var decayed = xchain.math.divide(xchain.math.multiply(drop, String(elapsed)), String(duration));
    return xchain.math.subtract(startPrice, decayed);
}
