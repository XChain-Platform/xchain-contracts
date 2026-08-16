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
// The contract ISSUES the sale token itself at deploy (it becomes the token's
// owner) and MINTS to each buyer on claim (a worked example of a contract
// creating and distributing a token. Pick a `saleTick` name that is not already
// taken: ticks are a global namespace and the deploy's constructor issue will
// fail if the name exists.
//
// CUSTODY MODEL: read this, it has a real footgun
//
// XChain has no msg.value. Buyers pay by DEPOSITing `payTick` to the contract and
// EXECUTEing buy() atomically, in ONE transaction:
//
//     BATCH( DEPOSIT(sale, PAY, amount), EXECUTE(sale, "buy") )
//
// buy() attributes the deposit to its caller by reading how much the contract's
// payTick balance grew since the last accounted buy. This is only safe because
// the DEPOSIT and buy() are atomic. **Never DEPOSIT without buy() in the same
// transaction.** An un-bought deposit would be credited to the NEXT buyer.
// ---------------------------------------------------------------------------

// Quantise a computed amount DOWN to its tick's decimal grid before emitting it.
// xchain.math computes at 64 significant digits, but the indexer normalises every
// emitted amount to its tick's decimals at ledger-write time (mathjs half-up
// round), which can round a computed quantity UP. For claim() that means minting
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

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        buy:      { summary: 'Attribute the deposited payment to the sale (BATCH after a DEPOSIT)', params: [] },
        finalize: { summary: 'Lock in the outcome after the deadline or hard cap', params: [] },
        claim:    { summary: 'Buyer mints purchased tokens (successful sale only)', params: [] },
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
        var duration = parseInt(xchain.getInputParam(6));
        var decimals = xchain.getInputParam(7) || '8';

        xchain.require(owner && payTick && saleTick, 'owner, payTick, saleTick required');
        xchain.require(payTick !== saleTick, 'payTick and saleTick must differ');
        xchain.require(rate && xchain.math.gt(rate, '0'), 'rate must be positive');
        xchain.require(softCap && xchain.math.gt(softCap, '0'), 'softCap must be positive');
        xchain.require(hardCap && xchain.math.gte(hardCap, softCap), 'hardCap must be >= softCap');
        xchain.require(duration > 0, 'durationBlocks must be a positive integer');
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
            description: 'Crowdsale token'
        });
    },

    // buy(): attribute the caller's deposit. BATCH after a DEPOSIT of payTick.
    // No tokens are delivered yet (claim later).
    buy: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'sale not open');
        xchain.require(xchain.getBlockHeight() < parseInt(xchain.state.get('deadline')), 'sale closed (deadline passed)');

        var payTick      = xchain.state.get('payTick');
        var balance      = xchain.getBalance(xchain.getContractAddress(), payTick) || '0';
        var accountedPay = xchain.state.get('accountedPay');
        var contributed  = xchain.math.subtract(balance, accountedPay);
        xchain.require(xchain.math.gt(contributed, '0'), 'no payment received (DEPOSIT in the same BATCH)');

        var raised = xchain.state.get('raised');
        var newRaised = xchain.math.add(raised, contributed);
        xchain.require(xchain.math.lte(newRaised, xchain.state.get('hardCap')), 'hard cap exceeded');

        var caller = xchain.getSourceAddress();
        var prior  = xchain.state.get('c:' + caller) || '0';
        xchain.state.set('c:' + caller, xchain.math.add(prior, contributed));
        xchain.state.set('accountedPay', balance);
        xchain.state.set('raised', newRaised);
    },

    // finalize(): lock in the outcome. Callable once the deadline passes, or
    // early once the hard cap is reached.
    finalize: function (xchain) {
        xchain.require(xchain.state.get('status') === 'OPEN', 'already finalized');
        var raised  = xchain.state.get('raised');
        var atCap   = xchain.math.gte(raised, xchain.state.get('hardCap'));
        var expired = xchain.getBlockHeight() >= parseInt(xchain.state.get('deadline'));
        xchain.require(atCap || expired, 'sale still open');

        xchain.state.set('status',
            xchain.math.gte(raised, xchain.state.get('softCap')) ? 'SUCCESS' : 'FAILED');
    },

    // claim(): buyer mints their purchased sale tokens (successful sale only).
    claim: function (xchain) {
        xchain.require(xchain.state.get('status') === 'SUCCESS', 'sale not successful');
        var caller = xchain.getSourceAddress();
        var paid   = xchain.state.get('c:' + caller) || '0';
        xchain.require(xchain.math.gt(paid, '0'), 'nothing to claim');

        // Floor the mint onto saleTick's decimal grid so the indexer's half-up
        // re-normalisation cannot round it UP (over-issuing past the rate and, across
        // buyers, past maxMint - which would revert a later claim and, on the rollback,
        // permanently strand that buyer's contribution). Legacy pre-fix deploys have no
        // saleDecimals key; default to the 8dp the issue used so old contracts still claim.
        var saleDecimals = parseInt(xchain.state.get('saleDecimals') || '8', 10);
        var tokens = floorToDecimals(xchain.math.multiply(paid, xchain.state.get('rate')), saleDecimals);
        // A sub-grid contribution (fractional rate + low saleDecimals) can floor to '0';
        // guard before deleting the record so the payment is never silently destroyed
        // (sibling templates guard every emitted quantity: amm 'insufficient liquidity
        // minted', vesting 'nothing to claim'). Leaves c:<caller> intact so the failure
        // is visible rather than burning the buyer's stake into an AMOUNT=0 no-op mint.
        xchain.require(xchain.math.gt(tokens, '0'), 'contribution below one sale-token unit');
        xchain.state.delete('c:' + caller); // zero out first (no double claim)

        xchain.emit.mint({
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
        xchain.require(xchain.math.gt(paid, '0'), 'nothing to refund');

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
