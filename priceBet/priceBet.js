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

// Upper bounds for the two integer constructor params. They are sanity ceilings,
// not protocol limits: both values are compared against, or added to, plain JS
// integers, so the point is to keep a fat-fingered constructor term inside the
// exactly-representable integer range rather than to constrain real bets.
// MAX_ROUND is ~1e9 oracle rounds (millennia at any plausible cadence);
// MAX_WINDOW_BLOCKS is 1e6 blocks (~19 years at 10-minute blocks), the same
// ceiling patterns/validation.js uses for a block window in its example.
var MAX_ROUND = 1000000000;
var MAX_WINDOW_BLOCKS = 1000000;

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
        requirePlainDecimal(xchain, strike, 'strike');
        xchain.require(side === 'OVER' || side === 'UNDER', 'side must be OVER or UNDER');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        // Notation gate, NOT a grid check (the tick's decimals are unreadable at
        // deploy). The positivity test above is no filter at all, and refundBoth()'s
        // floorToDecimals silently corrupts non-fixed input. See requirePlainDecimal.
        requirePlainDecimal(xchain, amount, 'amount');

        // Shape-check the integers, do NOT parseInt-then-range-check them. A
        // radix-less parseInt blesses spellings that mean something else entirely
        // ('1e2' -> 1, '0x10' -> 16, '7abc' -> 7, ' 7' -> 7), and both of these
        // params are raw maker-supplied constructor text measured in the same
        // deploy that stores them: a maker asking for a 100-block void window via
        // '1e2' would silently get a 1-block one, and their bet would be voidable
        // essentially immediately after it matched. See requireIntInRange.
        requireIntInRange(xchain, settleRound, 1, MAX_ROUND, 'settleRound');
        requireIntInRange(xchain, deadlineBlocks, 1, MAX_WINDOW_BLOCKS, 'deadlineBlocks');
        var round  = parseInt(settleRound, 10);
        var window = parseInt(deadlineBlocks, 10);

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
    //
    // The betting window closes the instant the settle round is published. The
    // whole design core (a settlement that is a pure function of consensus
    // history) means the outcome is PUBLIC once that round finalizes, so a
    // taker matching afterwards is not taking a bet, they are exercising a free
    // option on the maker's stake: match the winning side, settle immediately,
    // collect. The sibling priceBetTimed closes the same window on block time
    // (`settleTime`); here the round's own existence is the clock. The maker's
    // escape stays cancel(), which is OPEN-only and unaffected.
    accept: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'bet not open');

        var taker = xchain.getSourceAddress();
        xchain.require(taker !== xchain.state.get('maker'), 'maker cannot take their own bet');
        xchain.require(roundPrice(xchain) === null, 'settle round already published');

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

// Return each party's stake. The maker gets their stake floored onto the tick's
// decimal grid; the taker gets everything else, so any accidental over-deposit
// (and any sub-unit floor residue) drains with the refund instead of stranding
// in the contract. Callers set the terminal status BEFORE invoking this (state
// guard pattern).
//
// The maker leg is floored because `amount` is a caller-supplied term that
// initialize() cannot grid-check (getTokenInfo is unreadable at deploy: the
// contract holds nothing yet, so the VM ledger snapshot carries no entry for
// the tick). `held` is always on-grid, so flooring the maker leg makes `rest`
// on-grid too and the indexer's write-time re-round becomes a numeric no-op.
// Left raw, an `amount` sitting exactly half a base unit off the grid rounds
// BOTH legs UP (the indexer's bcmath is half-up), the pair exceeds custody by
// one unit, the taker's SEND fails its balance check and the throw reverts
// settle()'s PUSH path and reclaim() forever.
function refundBoth(xchain) {
    var tick   = xchain.state.get('tick');
    var amount = floorToDecimals(xchain.state.get('amount'), tickDecimals(xchain, tick));
    var held   = heldBalance(xchain);
    var rest   = xchain.math.subtract(held, amount);

    xchain.emit.send({ destination: xchain.state.get('maker'), tick: tick, quantity: amount });
    if (xchain.math.gt(rest, '0')) {
        xchain.emit.send({ destination: xchain.state.get('taker'), tick: tick, quantity: rest });
    }
}

// Reject any spelling of a numeric term that is not a plain fixed-notation
// decimal: digits, with at most one decimal point that has digits on both sides.
// Same helper and rationale as patterns/validation.js:requirePlainDecimal.
//
// Every OTHER template feeds floorToDecimals a value mathjs computed, and the VM's
// math API formats every result in fixed notation (xchain-vm/src/math.js toFixed),
// so fixed input is free there. Here `amount` and `strike` are raw maker-supplied
// constructor text (deploy.js pipe-splits CONSTRUCTOR_PARAMS with no numeric
// validation), and `xchain.math.gt(x, '0')` is no filter: mathjs accepts
// exponential ('1.5e-8'), radix prefixes ('0x10'), numeric separators ('1_000'),
// a leading '+', a bare leading dot, and 'Infinity'. Fed those, floorToDecimals
// does not merely no-op, it CORRUPTS:
//   '1.5e-8'       -> fraction '5e-8' is 4 chars, under an 8-decimal grid, so the
//                     already-on-grid early-return fires and the off-grid stake is
//                     emitted raw, wedging the PUSH/VOID refund permanently.
//   '1.23456789e2' -> returns '1.23456789' for a value of 123.456789, so the maker
//                     is refunded 1% of their stake and the rest silently follows
//                     the taker leg. No revert, no error: pure theft.
// Gate the notation once, at the only door untrusted text comes through, rather
// than at each consumer. This is NOT a grid check and does not replace the floor:
// '0.000000015' is legitimately spelled and still off an 8-decimal grid, and the
// tick's decimals are unreadable at deploy (the contract holds no balance yet), so
// refundBoth() still floors. Notation is checked here; the grid is checked there.
//
// No RegExp: the VM's syntax validator bans RegExp literals in contract source, so
// this is a character walk (same constraint that shaped crowdsale.js's round-trip
// integer check). The loop is gas-metered per iteration, so an oversized param
// exhausts the deployer's own gas rather than costing anyone else.
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
// accepts non-integers a range check then blesses ('1e2' -> 1, '0x10' -> 16,
// '7abc' -> 7, ' 7' -> 7, '5.99' -> 5), so initialize() would store a value the
// check never truly approved and the maker would get terms they never asked for.
// No RegExp (the VM's determinism validator rejects RegExp in contract source), so
// this is a character walk, same constraint that shaped requirePlainDecimal above.
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

// Quantise a quantity DOWN onto a tick's decimal grid. Pure exact string surgery
// on the fixed-notation decimal, deliberately not mathjs floor/mod (which round
// to the significant-digit precision, not the decimal grid). Same helper and
// rationale as treasury.js/amm.js:floorToDecimals. Its fixed-notation precondition
// is what requirePlainDecimal enforces at initialize(); do not relax that check
// without normalising here instead.
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

// Decimals of the bet tick, read from the ledger snapshot. refundBoth() only
// runs from PUSH/VOID, where both stakes are in custody, so the contract holds
// the tick and its token info is present (same VM_BALANCE_TOKENINFO gate that
// heldBalance's getBalance already rides). Mirrors treasury.js:tickDecimals.
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}
