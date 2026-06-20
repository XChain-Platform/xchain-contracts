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

module.exports = {

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
        var decimals = xchain.getInputParam(7);

        xchain.require(owner && payTick && saleTick, 'owner, payTick, saleTick required');
        xchain.require(payTick !== saleTick, 'payTick and saleTick must differ');
        xchain.require(rate && xchain.math.gt(rate, '0'), 'rate must be positive');
        xchain.require(softCap && xchain.math.gt(softCap, '0'), 'softCap must be positive');
        xchain.require(hardCap && xchain.math.gte(hardCap, softCap), 'hardCap must be >= softCap');
        xchain.require(duration > 0, 'durationBlocks must be a positive integer');

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

        var maxSale = xchain.math.multiply(hardCap, rate);
        xchain.emit.issue({
            tick: saleTick,
            maxSupply: maxSale,
            maxMint: maxSale,
            decimals: decimals || '8',
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

        var tokens = xchain.math.multiply(paid, xchain.state.get('rate'));
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
