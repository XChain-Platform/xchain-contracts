// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// priceBetTimed.js: binary option settled by the first oracle round at/after a timestamp
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
// The timestamp variant (v2) of the sibling priceBet template. In priceBet the
// parties agree on an oracle ROUND NUMBER up front; here they agree on a
// SETTLE TIME (unix seconds, e.g. "Friday 15:00 UTC") and the bet is decided
// by the FIRST finalized oracle round whose consensus timestamp is at/after
// that instant. Humans think in clock time, not round numbers; this template
// translates one into the other deterministically.
//
// HOW SETTLEMENT STAYS DETERMINISTIC (the design core)
//
// There is no getPriceAtBlock/getPriceAtTime in the VM oracle API, and using
// getPrice() ("latest right now") would let whoever calls settle() pick a
// favorable moment. Instead:
//
//   - accept() records a scan CURSOR at the round current when the bet is
//     matched (rounds finalized before the match can never qualify, because
//     accept() requires block time < settleTime and round timestamps are
//     consensus history).
//   - settle() walks rounds upward from the cursor via getPriceAtRound()
//     (immutable, consensus-finalized values) and the FIRST round with
//     timestamp >= settleTime decides. Gaps are skipped (rounds can be
//     'skipped'/'disputed'); the walk is capped per call and the cursor is
//     persisted, so a long stretch of pre-deadline rounds is paged through
//     across calls without ever exceeding the gas budget.
//
// The chosen round is a pure function of consensus history: any node, any
// caller, any time, same winner. Assumes round timestamps are non-decreasing
// in round number (they are consensus round products).
//
// PENDING vs REVERT: when no qualifying round exists yet, settle() RETURNS
// 'PENDING' (a valid, no-op execution) rather than reverting, so the cursor
// advance CAN persist (reverts discard state writes).
//
// Custody model, BATCH funding, and the liveness escape hatches are identical
// to priceBet; see that template's header for the full rationale.
// ---------------------------------------------------------------------------

// Upper bounds for the two integer constructor params. They are sanity ceilings,
// not protocol limits: both values are compared against, or added to, plain JS
// integers, so the point is to keep a fat-fingered constructor term inside the
// exactly-representable integer range rather than to constrain real bets.
// MAX_SETTLE_TIME is 253402300799, the last second of year 9999 in unix seconds:
// well past any 32-bit horizon (nothing here truncates to int32) and still small
// enough that the value is unmistakably a seconds-denominated timestamp rather
// than milliseconds. MAX_WINDOW_BLOCKS is 1e6 blocks (~19 years at 10-minute
// blocks), the same ceiling patterns/validation.js uses in its example.
var MAX_SETTLE_TIME = 253402300799;
var MAX_WINDOW_BLOCKS = 1000000;

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only.
    abi: { version: 1, methods: {
        fund:    { summary: 'Maker escrows their stake (BATCH after a DEPOSIT)', params: [] },
        accept:  { summary: 'Taker matches the stake and takes the opposite side (BATCH after a DEPOSIT)', params: [] },
        settle:  { summary: 'Pay the winner from the first oracle round at/after settleTime (anyone)', params: [] },
        cancel:  { summary: 'Maker reclaims their stake while the bet is unmatched', params: [] },
        reclaim: { summary: 'Void the bet and refund both sides if no qualifying round ever arrives', params: [] },
        info:    { summary: 'Read the bet terms and status', params: [], view: true }
    } },

    // initialize(maker, coinPair, strike, side, tick, amount, settleTime, deadlineBlocks)
    //   settleTime     unix seconds; the first finalized round with
    //                  timestamp >= settleTime decides the bet
    //   deadlineBlocks how many blocks after accept() before the bet can be
    //                  voided if no qualifying round has arrived
    //   (other params identical to priceBet)
    initialize: function (xchain) {
        var maker          = xchain.getInputParam(0);
        var coinPair       = xchain.getInputParam(1);
        var strike         = xchain.getInputParam(2);
        var side           = xchain.getInputParam(3);
        var tick           = xchain.getInputParam(4);
        var amount         = xchain.getInputParam(5);
        var settleTime     = xchain.getInputParam(6);
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
        // '1e2' would silently get a 1-block one, and a settleTime spelled in
        // exponential form would collapse to a timestamp in 1970 (which the
        // in-the-future check below then rejects with a message about the wrong
        // problem). See requireIntInRange.
        requireIntInRange(xchain, settleTime, 1, MAX_SETTLE_TIME, 'settleTime');
        requireIntInRange(xchain, deadlineBlocks, 1, MAX_WINDOW_BLOCKS, 'deadlineBlocks');
        var when = parseInt(settleTime, 10);
        xchain.require(when > xchain.getBlockTimestamp(), 'settleTime must be in the future');
        var window = parseInt(deadlineBlocks, 10);

        xchain.state.set('maker', maker);
        xchain.state.set('coinPair', coinPair);
        xchain.state.set('strike', strike);
        xchain.state.set('side', side);
        xchain.state.set('tick', tick);
        xchain.state.set('amount', amount);
        xchain.state.set('settleTime', String(when));
        xchain.state.set('window', String(window));
        xchain.state.set('status', 'INIT');
    },

    // fund(): maker escrows their stake. BATCHed after a DEPOSIT.
    fund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'INIT', 'bet not awaiting funds');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('maker'), 'only the maker funds');
        xchain.require(xchain.math.gte(heldBalance(xchain), xchain.state.get('amount')), 'insufficient deposit');
        xchain.state.set('status', 'OPEN');
    },

    // accept(): taker matches the stake before the settle time. Anchors the
    // liveness deadline AND the scan cursor: rounds already finalized at the
    // match can never qualify (their timestamps predate this block, which
    // predates settleTime), so the scan starts at the round current NOW. The
    // current round itself stays in scope (cursor = its number, not +1) as
    // slack for any clock skew between round consensus time and block time.
    accept: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'bet not open');

        var taker = xchain.getSourceAddress();
        xchain.require(taker !== xchain.state.get('maker'), 'maker cannot take their own bet');
        xchain.require(
            xchain.getBlockTimestamp() < parseInt(xchain.state.get('settleTime')),
            'betting window closed'
        );

        var needed = xchain.math.multiply(xchain.state.get('amount'), '2');
        xchain.require(xchain.math.gte(heldBalance(xchain), needed), 'insufficient deposit');

        var latest = latestRound(xchain);
        var cursor = (latest !== null && latest.roundNumber > 0) ? latest.roundNumber : 1;

        xchain.state.set('taker', taker);
        xchain.state.set('cursor', String(cursor));
        xchain.state.set('deadline', String(xchain.getBlockHeight() + parseInt(xchain.state.get('window'))));
        xchain.state.set('status', 'MATCHED');
    },

    // settle(): find the first finalized round with timestamp >= settleTime
    // and pay the winner. Callable by ANYONE: the deciding round is a pure
    // function of consensus history, so the caller has no discretion.
    //
    // Returns (instead of reverting) when the bet cannot settle yet:
    //   'PENDING'  - the oracle has not yet produced any round at/after
    //                settleTime; nothing to scan.
    //   'SCANNING' - qualifying rounds exist but the per-call read cap was
    //                hit paging through pre-deadline rounds; the cursor
    //                advance is persisted, call again to continue.
    settle: function (xchain) {
        xchain.require(xchain.state.get('status') === 'MATCHED', 'bet not matched / already settled');

        var T = parseInt(xchain.state.get('settleTime'));
        var latest = latestRound(xchain);
        xchain.require(latest !== null, 'no oracle data yet');

        // The latest round is the newest consensus product; if even it is
        // before T, no qualifying round can exist yet (timestamps are
        // non-decreasing in round number).
        if (latest.timestamp < T) return 'PENDING';

        // Walk from the cursor to the first round with timestamp >= T. Gaps
        // (skipped/disputed rounds) return null and are stepped over. The
        // walk is capped so a long backlog cannot exhaust gas; each read is
        // a metered VM_STATE-class charge (100 gas).
        var MAX_READS = 200;
        var coinPair = xchain.state.get('coinPair');
        var r     = parseInt(xchain.state.get('cursor'));
        var top   = latest.roundNumber;
        var found = null;

        // A null read is a genuine gap and is stepped over. A read that arrives
        // WITHOUT round metadata is not a gap: normalize() gives it timestamp
        // NaN, `NaN >= T` is false, so it would be stepped over exactly like a
        // gap while the cursor advances past it, and a LATER round would decide
        // the bet. latestRound() already refuses that shape; the scan refuses it
        // identically, or the loud failure normalize() promises degrades into a
        // silent mis-settlement.
        for (var i = 0; i < MAX_READS && r <= top; i++, r++) {
            var data = normalize(xchain.oracle.getPriceAtRound(coinPair, r));
            if (data === null) continue;
            xchain.require(
                !isNaN(data.roundNumber) && !isNaN(data.timestamp),
                'oracle accessor lacks round metadata'
            );
            if (data.timestamp >= T) { found = data; break; }
        }

        if (found === null) {
            // Cap hit mid-backlog. Persist the progress and report; a revert
            // here would throw the cursor advance away.
            xchain.state.set('cursor', String(r));
            return 'SCANNING';
        }

        var strike = xchain.state.get('strike');

        // Exactly at the strike: a push. Both stakes go back.
        if (xchain.math.eq(found.price, strike)) {
            xchain.state.set('status', 'PUSH');
            refundBoth(xchain);
            return 'PUSH';
        }

        var overWon = xchain.math.gt(found.price, strike);
        var makerIsOver = xchain.state.get('side') === 'OVER';
        var winner = (overWon === makerIsOver) ? xchain.state.get('maker') : xchain.state.get('taker');
        var pot = heldBalance(xchain);

        // Terminal status BEFORE emitting (state guard pattern, as in all
        // sibling templates).
        xchain.state.set('status', 'SETTLED');
        xchain.state.set('winner', winner);
        xchain.state.set('settledRound', String(found.roundNumber));

        xchain.emit.send({
            destination: winner,
            tick: xchain.state.get('tick'),
            quantity: pot
        });
        return 'SETTLED';
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

    // reclaim(): liveness escape hatch. If `deadlineBlocks` after the match
    // the oracle has STILL not produced any round at/after settleTime, either
    // party voids the bet and both stakes are returned. The guard is O(1):
    // qualifying rounds exist iff the LATEST round's timestamp reaches T.
    // Once one exists, settle() is the only path - reclaim() cannot be used
    // to dodge a lost bet.
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

        var latest = latestRound(xchain);
        xchain.require(
            latest === null || latest.timestamp < parseInt(xchain.state.get('settleTime')),
            'qualifying round exists: settle() instead'
        );

        xchain.state.set('status', 'VOID');
        refundBoth(xchain);
    },

    info: function (xchain) {
        return {
            status:       xchain.state.get('status'),
            coinPair:     xchain.state.get('coinPair'),
            strike:       xchain.state.get('strike'),
            side:         xchain.state.get('side'),
            tick:         xchain.state.get('tick'),
            amount:       xchain.state.get('amount'),
            settleTime:   xchain.state.get('settleTime'),
            settledRound: xchain.state.get('settledRound') || null,
            winner:       xchain.state.get('winner') || null
        };
    }
};

// Normalize an oracle read to { price, roundNumber, timestamp } or null. The
// production accessor (indexer getOracleDataForVM via xchain-vm
// readonly-accessors) returns that object; a bare-string price (legacy/mock
// accessors) carries no round metadata, which this template cannot work
// without - surface that loudly instead of mis-settling.
function normalize(r) {
    if (r === null || r === undefined) return null;
    if (typeof r === 'object') {
        return {
            price:       (r.price === null || r.price === undefined) ? null : String(r.price),
            roundNumber: parseInt(r.roundNumber),
            timestamp:   parseInt(r.timestamp)
        };
    }
    return { price: String(r), roundNumber: NaN, timestamp: NaN };
}

// Latest finalized round for the bet's pair, normalized; null if none.
// Requires round metadata (see normalize).
function latestRound(xchain) {
    var latest = normalize(xchain.oracle.getPrice(xchain.state.get('coinPair')));
    if (latest === null) return null;
    xchain.require(
        !isNaN(latest.roundNumber) && !isNaN(latest.timestamp),
        'oracle accessor lacks round metadata'
    );
    return latest;
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
