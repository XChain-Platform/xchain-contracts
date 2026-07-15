// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// priceBet.js: two-party binary option settled by the PRICE oracle
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
// A binary option on an oracle price. The maker deploys the bet with fixed
// terms: a coin pair (e.g. BTC/USD), a strike price, a side (OVER or UNDER),
// a stake amount, and the oracle ROUND that decides the outcome. A taker
// matches the stake to take the opposite side. When the oracle publishes the
// agreed round, ANYONE can settle: if the round price is above the strike the
// OVER side wins the whole pot; below, UNDER wins; exactly equal is a push and
// both stakes are returned.
//
// Settlement is fully deterministic: it reads getPriceAtRound(pair, round) --
// a consensus-finalized historical value -- so WHEN settle() is called can
// never change WHO wins. That is why settlement is permissionless.
//
// CUSTODY MODEL (same as the sibling templates)
//
// There is no msg.value on XChain. Stakes enter via DEPOSIT to the contract's
// address; logic runs via EXECUTE. Fund-and-act atomically with BATCH:
//
//     BATCH( DEPOSIT(this_contract, TICK, STAKE), EXECUTE(this_contract, "fund") )
//     BATCH( DEPOSIT(this_contract, TICK, STAKE), EXECUTE(this_contract, "accept") )
//
// The contract never trusts a caller-supplied amount; it reads its own balance.
//
// LIVENESS ESCAPE HATCHES
//
//   - cancel(): the maker reclaims their stake while no taker has matched.
//   - reclaim(): if the oracle round is still unpublished `deadlineBlocks`
//     after the match, either party can void the bet and refund both sides.
// ---------------------------------------------------------------------------

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only.
    abi: { version: 1, methods: {
        fund:    { summary: 'Maker escrows their stake (BATCH after a DEPOSIT)', params: [] },
        accept:  { summary: 'Taker matches the stake and takes the opposite side (BATCH after a DEPOSIT)', params: [] },
        settle:  { summary: 'Pay the winner from the oracle round price (anyone, once the round exists)', params: [] },
        cancel:  { summary: 'Maker reclaims their stake while the bet is unmatched', params: [] },
        reclaim: { summary: 'Void the bet and refund both sides if the oracle round never arrives', params: [] },
        info:    { summary: 'Read the bet terms and status', params: [], view: true }
    } },

    // initialize(maker, coinPair, strike, side, tick, amount, settleRound, deadlineBlocks)
    //   maker          address that funds the OVER-or-UNDER position declared in `side`
    //   coinPair       oracle pair, e.g. 'BTC/USD'
    //   strike         price the round is compared against (bignumber string)
    //   side           'OVER' or 'UNDER': the MAKER wins if the round price is
    //                  strictly above / strictly below the strike
    //   tick           token both stakes are denominated in
    //   amount         stake each party must escrow (bignumber string)
    //   settleRound    oracle round number whose price decides the bet
    //   deadlineBlocks how many blocks after accept() before the bet can be
    //                  voided if the oracle round is still unpublished
    initialize: function (xchain) {
        var maker          = xchain.getInputParam(0);
        var coinPair       = xchain.getInputParam(1);
        var strike         = xchain.getInputParam(2);
        var side           = xchain.getInputParam(3);
        var tick           = xchain.getInputParam(4);
        var amount         = xchain.getInputParam(5);
        var settleRound    = xchain.getInputParam(6);
        var deadlineBlocks = xchain.getInputParam(7);

        xchain.require(maker, 'maker required');
        xchain.require(coinPair, 'coinPair required');
        xchain.require(strike && xchain.math.gt(strike, '0'), 'strike must be positive');
        xchain.require(side === 'OVER' || side === 'UNDER', 'side must be OVER or UNDER');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');

        // parseInt(...) > 0 rejects NaN, zero, and negatives in one check.
        var round = parseInt(settleRound);
        xchain.require(round > 0, 'settleRound must be a positive integer');
        var window = parseInt(deadlineBlocks);
        xchain.require(window > 0, 'deadlineBlocks must be a positive integer');

        xchain.state.set('maker', maker);
        xchain.state.set('coinPair', coinPair);
        xchain.state.set('strike', strike);
        xchain.state.set('side', side);
        xchain.state.set('tick', tick);
        xchain.state.set('amount', amount);
        xchain.state.set('settleRound', String(round));
        // The void window is anchored in accept(), not here: it protects the
        // MATCHED pot, and the clock should start when both stakes are locked.
        xchain.state.set('window', String(window));
        xchain.state.set('status', 'INIT');
    },

    // fund(): maker escrows their stake. BATCHed after a DEPOSIT. The on-chain
    // balance is the source of truth; a caller-supplied amount is never trusted.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'bet not awaiting funds');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('maker'), 'only the maker funds');

        var held = heldBalance(xchain);
        xchain.require(xchain.math.gte(held, xchain.state.get('amount')), 'insufficient deposit');

        xchain.state.set('status', 'OPEN');
    },

    // accept(): taker matches the stake and takes the opposite side. BATCHed
    // after a DEPOSIT. Requires the pot to hold BOTH stakes (2 x amount).
    accept: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'bet not open');

        var taker = xchain.getSourceAddress();
        xchain.require(taker !== xchain.state.get('maker'), 'maker cannot take their own bet');

        var needed = xchain.math.multiply(xchain.state.get('amount'), '2');
        xchain.require(xchain.math.gte(heldBalance(xchain), needed), 'insufficient deposit');

        xchain.state.set('taker', taker);
        // Anchor the oracle-liveness deadline at the match, when both stakes
        // are actually at risk.
        xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
        xchain.state.set('status', 'MATCHED');
    },

    // settle(): pay the winner. Callable by ANYONE once the oracle has
    // published the agreed round -- the outcome depends only on that
    // consensus-finalized price, never on who calls or when.
    settle: function (xchain) {
        xchain.require(xchain.state.get('status') === 'MATCHED', 'bet not matched / already settled');

        var price = roundPrice(xchain);
        xchain.require(price !== null, 'settle round not published yet');

        var strike = xchain.state.get('strike');

        // Exactly at the strike: a push. Both stakes go back.
        if (xchain.math.eq(price, strike)) {
            xchain.state.set('status', 'PUSH');
            refundBoth(xchain);
            return;
        }

        // Strictly above the strike -> OVER wins; strictly below -> UNDER.
        var overWon = xchain.math.gt(price, strike);
        var makerIsOver = xchain.state.get('side') === 'OVER';
        var winner = (overWon === makerIsOver) ? xchain.state.get('maker') : xchain.state.get('taker');

        var pot = heldBalance(xchain);

        // Terminal status BEFORE emitting (state guard pattern: the write and
        // the emission commit atomically, but the guard-first ordering keeps
        // double-settlement structurally impossible).
        xchain.state.set('status', 'SETTLED');
        xchain.state.set('winner', winner);

        xchain.emit.send({
            destination: winner,
            tick: xchain.state.get('tick'),
            quantity: pot
        });
    },

    // cancel(): maker reclaims their stake while nobody has matched the bet.
    cancel: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'bet not open');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('maker'), 'only the maker can cancel');

        var held = heldBalance(xchain);
        xchain.state.set('status', 'CANCELLED');

        xchain.emit.send({
            destination: xchain.state.get('maker'),
            tick: xchain.state.get('tick'),
            quantity: held
        });
    },

    // reclaim(): liveness escape hatch. If the agreed oracle round is STILL
    // unpublished `deadlineBlocks` after the match, either party voids the bet
    // and both stakes are returned. If the round exists, settle() is the only
    // path -- reclaim() cannot be used to dodge a lost bet.
    reclaim: function (xchain) {
        xchain.require(xchain.state.get('status') === 'MATCHED', 'bet not matched');

        var caller = xchain.getSourceAddress();
        xchain.require(
            caller === xchain.state.get('maker') || caller === xchain.state.get('taker'),
            'caller not a party to this bet'
        );
        xchain.require(
            xchain.getBlockHeight() >= parseInt(xchain.state.get('deadline')),
            'deadline not reached'
        );

        xchain.require(roundPrice(xchain) === null, 'round published: settle() instead');

        xchain.state.set('status', 'VOID');
        refundBoth(xchain);
    },

    info: function (xchain) {
        return {
            status:      xchain.state.get('status'),
            coinPair:    xchain.state.get('coinPair'),
            strike:      xchain.state.get('strike'),
            side:        xchain.state.get('side'),
            tick:        xchain.state.get('tick'),
            amount:      xchain.state.get('amount'),
            settleRound: xchain.state.get('settleRound'),
            winner:      xchain.state.get('winner') || null
        };
    }
};

// Price of the agreed settle round, normalized to a bignumber string, or null
// if the round is not yet published. The production accessor returns a
// { price, roundNumber, timestamp } object (indexer's getOracleDataForVM via
// xchain-vm/src/readonly-accessors.js); older/mocked accessors may return the
// bare price string. Accept both.
function roundPrice(xchain) {
    var r = xchain.oracle.getPriceAtRound(
        xchain.state.get('coinPair'),
        parseInt(xchain.state.get('settleRound'))
    );
    if (r === null || r === undefined) return null;
    if (typeof r === 'object') return (r.price === null || r.price === undefined) ? null : String(r.price);
    return String(r);
}

// Contract's own balance of the bet tick. The single source of truth for
// custody; caller-supplied amounts are never trusted.
function heldBalance(xchain) {
    return xchain.getBalance(xchain.getContractAddress(), xchain.state.get('tick')) || '0';
}

// Return each party's stake. The maker gets exactly `amount`; the taker gets
// everything else, so any accidental over-deposit drains with the refund
// instead of stranding in the contract. Callers set the terminal status
// BEFORE invoking this (state guard pattern).
function refundBoth(xchain) {
    var tick   = xchain.state.get('tick');
    var amount = xchain.state.get('amount');
    var held   = heldBalance(xchain);
    var rest   = xchain.math.subtract(held, amount);

    xchain.emit.send({ destination: xchain.state.get('maker'), tick: tick, quantity: amount });
    if (xchain.math.gt(rest, '0')) {
        xchain.emit.send({ destination: xchain.state.get('taker'), tick: tick, quantity: rest });
    }
}
