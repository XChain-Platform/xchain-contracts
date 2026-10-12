// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// crowdsale.js: capped token sale with a soft cap, deadline, and refunds
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
// A fundraising sale. Buyers pay in `payTick` and are promised `rate` units of a
// brand-new `saleTick` per unit paid. The sale has a soft cap (minimum to be a
// success) and a hard cap (maximum accepted), and it runs until a deadline.
//
//   - SUCCESS (raised >= softCap): buyers claim() their sale tokens; the owner
//     withdraw()s the proceeds.
//   - FAILURE (raised < softCap at the deadline): buyers refund() their payment
//     in full; nothing is owed.
//
// The contract ISSUES and pre-mints the full sale-token supply into its custody
// at deploy, locks further minting, and SENDS tokens to each buyer on claim. Pick
// a `saleTick` name that is not already taken: ticks are a global namespace and
// the deploy's constructor issue will fail if the name exists.
//
// CUSTODY MODEL: read this, it has a real footgun
//
// XChain has no msg.value. Buyers pay by DEPOSITing `payTick` to the contract and
// EXECUTEing buy() in ONE transaction:
//
//     BATCH( DEPOSIT(sale, PAY, amount), EXECUTE(sale, "buy") )
//
// buy() attributes the deposit to its caller by reading how much the contract's
// payTick balance grew since the last accounted buy. This is only safe because
// the DEPOSIT and buy() ride in the same BATCH. **Never DEPOSIT without buy() in
// the same transaction.** An un-bought deposit would be credited to the NEXT buyer.
//
// A BATCH is NOT atomic, which is WHY that rule matters: its sub-actions settle
// independently, so a buy() that reverts ('sale closed (deadline passed)', 'hard
// cap exceeded', and the other guards) leaves the DEPOSIT ahead of it standing,
// and the next buyer's delta absorbs it. Size the payment to clear.
// ---------------------------------------------------------------------------

// Quantise a computed amount DOWN to its tick's decimal grid before emitting it.
// xchain.math computes at 64 significant digits, but the indexer normalises every
// emitted amount to its tick's decimals at ledger-write time (mathjs HALF-UP
// round: the indexer's bcmath rounds half-up, NOT half-even, the mode is stated in
// xchain-indexer/src/consensus/xchain_price.js and pinned by test, because a mis-read mode at
// the .5 boundary is a consensus fork),
// which can round a computed quantity UP. For claim() that means minting
// MORE saleTick than paid*rate and, cumulatively across buyers, past the maxMint
// supply cap so a later honest claim reverts and (because the whole EXECUTE rolls
// back) that buyer's contribution record survives and is permanently unclaimable.
// Flooring the mint onto saleTick's grid makes the indexer re-normalisation a no-op.
// Same helper and rationale as amm.js:floorToDecimals; pure exact string surgery on
// the fixed-notation decimal, deliberately not mathjs floor/mod (which round to the
// significant-digit precision, not the decimal grid).
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

// Upper bound for the sale window. A sanity ceiling, not a protocol limit:
// initialize() adds this window to a plain JS block height, so the point is to
// keep a fat-fingered constructor term inside the exactly-representable integer
// range rather than to constrain a real sale. MAX_WINDOW_BLOCKS is 1e6 blocks
// (~19 years at 10-minute blocks), the same ceiling treasury.js, stableVault.js
// and patterns/validation.js use for a block window.
var MAX_WINDOW_BLOCKS = 1000000;

// Throw unless `v` is a canonical base-10 integer string within [min, max]
// inclusive. Same helper and rationale as patterns/validation.js:requireIntInRange.
//
// Validate the SHAPE of `v`, not parseInt(v): a radix-less parseInt silently
// accepts spellings a magnitude check then blesses ('1e3' -> 1, '0x10' -> 16,
// '5abc' -> 5, ' 5' -> 5, '5.99' -> 5), so initialize() would store a deadline the
// check never truly approved and the sale would run on a window nobody chose.
// No RegExp (the VM's determinism validator rejects RegExp in contract source), so
// this is a character walk. Inlined rather than imported: contract sources load as
// a single file into the isolated VM.
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
// xchain.math.gte/lte treat values within a 1e-12 relative tolerance as equal, so they
// cannot guard the caps. Same helper as patterns/validation.js:isAtLeastExact.
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

// Reject non-decimal notation ('Infinity', 'NaN', exponents) before it reaches the issued supply.
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

// Decimals of the pay tick, read from the ledger snapshot. buy() reads it only after a
// DEPOSIT landed, so the contract holds the tick and its token info is present.
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}

// Return one base unit of a `decimals`-place grid as a fixed-notation string.
function gridUnit(decimals) {
    var s = '1';
    for (var i = 0; i < decimals; i++) s = (i === decimals - 1) ? '0.' + s : '0' + s;
    return s;
}

// True when paying `a` mints at least `tokens`, by the same floor claim() applies.
function buysUnits(xchain, a, rate, saleDec, tokens) {
    return isAtLeastExact(xchain, floorToDecimals(xchain.math.multiply(a, rate), saleDec), tokens);
}

// Return the smallest pay-grid amount, at most `total`, that mints what `total` mints,
// or '0' below one sale unit. An exact on-grid total returns at once, reading no token
// info. The estimate is walked at most two units each way (the divide rounds at 64 digits).
function acceptedFor(xchain, total) {
    var rate = xchain.state.get('rate');
    var saleDec = parseInt(xchain.state.get('saleDecimals') || '8', 10);
    var product = xchain.math.multiply(total, rate);
    var tokens = floorToDecimals(product, saleDec);
    if (isAtLeastExact(xchain, tokens, product)) return total;
    if (xchain.math.isZero(tokens)) return '0';
    var payDec = tickDecimals(xchain, xchain.state.get('payTick'));
    var unit = gridUnit(payDec);
    var est = xchain.math.divide(tokens, rate);
    var a = floorToDecimals(est, payDec);
    if (!isAtLeastExact(xchain, a, est)) a = xchain.math.add(a, unit);
    for (var i = 0; i < 2 && !buysUnits(xchain, a, rate, saleDec, tokens); i++) a = xchain.math.add(a, unit);
    for (var j = 0; j < 2; j++) {
        var less = xchain.math.subtract(a, unit);
        if (xchain.math.isZero(less) || !buysUnits(xchain, less, rate, saleDec, tokens)) break;
        a = less;
    }
    xchain.require(buysUnits(xchain, a, rate, saleDec, tokens) && isAtLeastExact(xchain, total, a),
        'payment cannot be priced on the pay grid');
    return a;
}

module.exports = {

    // Contract identity, read off this export at deploy and recorded on chain:
    // consensus REQUIRES name and description under CONTRACT_META_REQUIRED, and
    // meta.version must be bumped on any edit to this source (see CONTRIBUTING.md).
    meta: {
        name:        'Crowdsale',
        description: 'Capped token sale with a soft cap, a hard cap and a deadline: the contract issues a fixed sale-token inventory at deploy and sends it to buyers who claim after a successful raise, while a raise that misses the soft cap refunds every buyer in full.',
        version:     '1.3.4'
    },

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/contract-abi.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        buy:      { summary: 'Attribute the deposited payment to the sale, returning change past whole sale units (BATCH after a DEPOSIT)', params: [] },
        finalize: { summary: 'Lock in the outcome after the deadline or hard cap', params: [] },
        claim:    { summary: 'Buyer receives purchased tokens (successful sale only)', params: [] },
        refund:   { summary: 'Buyer reclaims their payment (failed sale only)', params: [] },
        withdraw: { summary: 'Owner takes the proceeds (successful sale only)', params: [] },
        info:     { summary: 'Read the sale terms and progress', params: [], view: true }
    } },

    // initialize(owner, payTick, saleTick, rate, softCap, hardCap, durationBlocks, saleDecimals)
    // Issues the sale token (max supply = hardCap * rate, contract-owned) and
    // opens the sale until getBlockHeight() + durationBlocks.
    initialize: function (xchain) {
        var owner    = xchain.getInputParam(0);
        var payTick  = xchain.getInputParam(1);
        var saleTick = xchain.getInputParam(2);
        var rate     = xchain.getInputParam(3);
        var softCap  = xchain.getInputParam(4);
        var hardCap  = xchain.getInputParam(5);
        var durationRaw = xchain.getInputParam(6);
        var decimals = xchain.getInputParam(7) || '8';

        xchain.require(owner && payTick && saleTick, 'owner, payTick, saleTick required');
        xchain.require(payTick !== saleTick, 'payTick and saleTick must differ');
        xchain.require(rate, 'rate must be positive');
        requirePlainDecimal(xchain, rate, 'rate');
        xchain.require(xchain.math.gt(rate, '0'), 'rate must be positive');
        xchain.require(softCap && xchain.math.gt(softCap, '0'), 'softCap must be positive');
        // Require hardCap >= softCap exactly, or the exact soft-cap check could never pass.
        xchain.require(hardCap && isAtLeastExact(xchain, hardCap, softCap), 'hardCap must be >= softCap');
        // Shape-check the window, do NOT parseInt-then-range-check it. This is the
        // same discipline saleDecimals gets nine lines below, and for the same
        // reason: durationBlocks is raw deployer text measured in the same deploy
        // that burns it into the permanent `deadline` key, and a radix-less
        // parseInt blesses spellings that mean something else entirely ('1e3' -> 1,
        // '0x10' -> 16, '5.99' -> 5, ' 5' -> 5, '+5' -> 5, '5abc' -> 5). A sale the
        // DEPLOY action advertises as 1000 blocks would open for one: buy() rejects
        // every later contribution and finalize() then latches FAILED for want of
        // the soft cap. See requireIntInRange.
        requireIntInRange(xchain, durationRaw, 1, MAX_WINDOW_BLOCKS, 'durationBlocks');
        var duration = parseInt(durationRaw, 10);
        // saleDecimals defines both the sale token's permanent grid (emit.issue) and
        // claim()'s mint quantisation; a malformed value would desync the two sinks
        // (parseInt(NaN) makes floorToDecimals truncate to the integer part while the
        // issue carries the raw string). Validate here so the whole deploy fails
        // cleanly instead. ISSUE permits 0-18 decimals; the round-trip check rejects
        // non-numeric input, fractions, negatives, and leading zeros without a RegExp
        // (the VM's syntax validator bans RegExp in contract source).
        var decInt = parseInt(decimals, 10);
        xchain.require(String(decInt) === String(decimals) && decInt >= 0 && decInt <= 18,
            'saleDecimals must be an integer 0-18');

        xchain.state.set('owner', owner);
        xchain.state.set('payTick', payTick);
        xchain.state.set('saleTick', saleTick);
        xchain.state.set('rate', rate);
        xchain.state.set('softCap', softCap);
        xchain.state.set('hardCap', hardCap);
        xchain.state.set('deadline', String(xchain.getBlockHeight() + duration));
        xchain.state.set('raised', '0');
        xchain.state.set('accountedPay', '0');
        xchain.state.set('withdrawn', 'false');
        xchain.state.set('status', 'OPEN');
        // Persist the sale token's decimal grid so claim() can floor its mint onto
        // it (initialize is the only place the grid is known; getTokenInfo(saleTick)
        // is not reliably readable by a contract that holds no saleTick balance).
        xchain.state.set('saleDecimals', decimals);

        var maxSale = xchain.math.multiply(hardCap, rate);
        xchain.emit.issue({
            tick: saleTick,
            maxSupply: maxSale,
            maxMint: maxSale,
            decimals: decimals,
            description: 'Crowdsale token',
            mintSupply: maxSale,
            lockMint: '1',
            lockMintSupply: '1'
        });
    },

    // buy(): attribute the caller's deposit. BATCH after a DEPOSIT of payTick.
    // No tokens are delivered yet (claim later). Change past whole sale units is
    // returned at once, and a payment worth less than one unit comes back in full.
    buy: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'sale not open');
        xchain.require(xchain.getBlockHeight() < parseInt(xchain.state.get('deadline')), 'sale closed (deadline passed)');

        var payTick      = xchain.state.get('payTick');
        var balance      = xchain.getBalance(xchain.getContractAddress(), payTick) || '0';
        var accountedPay = xchain.state.get('accountedPay');
        var contributed  = xchain.math.subtract(balance, accountedPay);
        xchain.require(xchain.math.gt(contributed, '0'), 'no payment received (DEPOSIT in the same BATCH)');

        var caller = xchain.getSourceAddress();
        var prior  = xchain.state.get('c:' + caller) || '0';
        var total  = xchain.math.add(prior, contributed);
        // Keep only what buys whole sale units and return the rest now, so every stored
        // contribution mints exactly and no payment reaches the owner without tokens.
        var accepted = acceptedFor(xchain, total);
        xchain.require(isAtLeastExact(xchain, accepted, prior), 'accepted amount below the prior contribution');
        var change = xchain.math.subtract(total, accepted);
        var delta  = xchain.math.isZero(change) ? contributed : xchain.math.subtract(accepted, prior);

        var raised = xchain.state.get('raised');
        var newRaised = xchain.math.add(raised, delta);
        // Refuse a raise past hardCap, compared exactly: a tolerant gate lets the claims
        // sum past the token's exact MAX_SUPPLY and strands the last claimer.
        xchain.require(isAtLeastExact(xchain, xchain.state.get('hardCap'), newRaised), 'hard cap exceeded');

        if (!xchain.math.isZero(accepted)) xchain.state.set('c:' + caller, accepted);
        // The change leaves custody through the SEND below, so it is not accounted pay.
        xchain.state.set('accountedPay', xchain.math.subtract(balance, change));
        xchain.state.set('raised', newRaised);
        // Test the change exactly, as delta and accountedPay do (gt reads a change <= 1e-15 as zero).
        if (!xchain.math.isZero(change))
            xchain.emit.send({ destination: caller, tick: payTick, quantity: change });
    },

    // finalize(): lock in the outcome. Callable once the deadline passes, or
    // early once the hard cap is reached.
    finalize: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'already finalized');
        var raised  = xchain.state.get('raised');
        // Allow an early close only once the hard cap is met exactly.
        var atCap   = isAtLeastExact(xchain, raised, xchain.state.get('hardCap'));
        var expired = xchain.getBlockHeight() >= parseInt(xchain.state.get('deadline'));
        xchain.require(atCap || expired, 'sale still open');

        // Succeed only when the soft cap is met exactly; one base unit short refunds.
        xchain.state.set('status',
            isAtLeastExact(xchain, raised, xchain.state.get('softCap')) ? 'SUCCESS' : 'FAILED');
    },

    // claim(): send the buyer's purchased sale tokens (successful sale only).
    claim: function (xchain) {
        xchain.require(xchain.state.get('status') === 'SUCCESS', 'sale not successful');
        var caller = xchain.getSourceAddress();
        var paid   = xchain.state.get('c:' + caller) || '0';
        // Test the record exactly, as buy() stored it (gt reads a record <= 1e-15 as zero).
        xchain.require(!xchain.math.isZero(paid), 'nothing to claim');

        // Floor the mint onto saleTick's decimal grid so the indexer's half-up
        // re-normalisation cannot round it UP (over-issuing past the rate and, across
        // buyers, past maxMint - which would revert a later claim and, on the rollback,
        // permanently strand that buyer's contribution). Legacy pre-fix deploys have no
        // saleDecimals key; default to the 8dp the issue used so old contracts still claim.
        var saleDecimals = parseInt(xchain.state.get('saleDecimals') || '8', 10);
        var tokens = floorToDecimals(xchain.math.multiply(paid, xchain.state.get('rate')), saleDecimals);
        // Defence in depth (buy() records only amounts that mint whole units): a mint that
        // floors to '0' reverts before the record is deleted, so a payment is never silently
        // destroyed into an AMOUNT=0 no-op mint, as amm and vesting guard their emissions.
        xchain.require(!xchain.math.isZero(tokens), 'contribution below one sale-token unit');
        xchain.state.delete('c:' + caller); // zero out first (no double claim)

        xchain.emit.send({
            tick: xchain.state.get('saleTick'),
            quantity: tokens,
            destination: caller
        });
        return tokens;
    },

    // refund(): buyer reclaims their payment in full (failed sale only).
    refund: function (xchain) {
        xchain.require(xchain.state.get('status') === 'FAILED', 'sale did not fail');
        var caller = xchain.getSourceAddress();
        var paid   = xchain.state.get('c:' + caller) || '0';
        // Exact, as in claim(): a tolerant gt would strand a record <= 1e-15 in custody.
        xchain.require(!xchain.math.isZero(paid), 'nothing to refund');

        xchain.state.delete('c:' + caller); // zero out first (no double refund)

        xchain.emit.send({
            destination: caller,
            tick: xchain.state.get('payTick'),
            quantity: paid
        });
        return paid;
    },

    // withdraw(): owner takes the proceeds (successful sale only, once).
    withdraw: function (xchain) {
        xchain.require(xchain.state.get('status') === 'SUCCESS', 'sale not successful');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'only the owner can withdraw');
        xchain.require(xchain.state.get('withdrawn') !== 'true', 'already withdrawn');

        xchain.state.set('withdrawn', 'true');
        xchain.emit.send({
            destination: xchain.state.get('owner'),
            tick: xchain.state.get('payTick'),
            quantity: xchain.state.get('raised')
        });
        return xchain.state.get('raised');
    },

    info: function (xchain) {
        return JSON.stringify({
            status: xchain.state.get('status'),
            raised: xchain.state.get('raised'),
            softCap: xchain.state.get('softCap'),
            hardCap: xchain.state.get('hardCap'),
            deadline: xchain.state.get('deadline')
        });
    }
};
