'use strict';

function createExactHelpers(context) {
    const { ADDR, BID, E2EHarness, ITEM, SELLER, XChainVM, CODE } = context;

    async function deployExact(itemAmount) {
        context.h = new E2EHarness(XChainVM);
        context.h.seedBalance(SELLER, 'XCHAIN', '1000000');
        context.h.seedBalance(SELLER, ITEM, '20000');
        context.h.ledger.setTokenDecimals(ITEM, 8);
        context.h.ledger.setTokenDecimals(BID, 8);
        return context.h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR,
            params: [SELLER, ITEM, itemAmount, BID, '100000', '10000', '10'] });
    }

    async function fundWith(amount) {
        context.h.deposit(SELLER, ADDR, ITEM, amount);
        return context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER });
    }

    return { deployExact, fundWith };
}

function registerFundShortCase(context, { deployExact, fundWith }) {
    const { ADDR, ITEM, assertBalance, assertContractState, assertReverted, assertSuccess, buy } = context;

    it('fund() rejects an item deposit one base unit short, and a top-up then sells exactly', async function () {
        assertSuccess(await deployExact('10000'));
        assertReverted(await fundWith('9999.99999999'), 'insufficient item deposit');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
        assertSuccess(await fundWith('0.00000001'));
        assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
        assertSuccess(await buy('alice', '100000'));
        assertBalance(context.h.ledger, 'alice', ITEM, '10000');
    });
}

function registerBuyShortCase(context, { deployExact, fundWith }) {
    const { ADDR, BID, SELLER, assertBalance, assertContractBalance, assertContractState,
        assertSuccess, buy } = context;

    it('buy() refunds a payment one base unit short instead of selling, and exact pays the seller', async function () {
        assertSuccess(await deployExact('10'));
        assertSuccess(await fundWith('10'));
        const r = await buy('alice', '99999.99999999');
        assertSuccess(r);
        context.assert.strictEqual(JSON.parse(r.returnValue), 'underpaid');
        assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
        assertContractBalance(context.h.ledger, ADDR, BID, '0');
        assertBalance(context.h.ledger, 'alice', BID, '99999.99999999');
        assertSuccess(await buy('bob', '100000'));
        assertContractState(context.h.ledger, ADDR, 'buyer', 'bob');
        assertBalance(context.h.ledger, SELLER, BID, '100000');
    });
}

function registerBidDustCase(context, { deployExact, fundWith }) {
    const { ADDR, BID, SELLER, assertBalance, assertContractBalance, assertSuccess, buy } = context;

    it('buy() returns positive bid dust on both underpayment and excess paths', async function () {
        const dust = '0.000000000000000001';
        assertSuccess(await deployExact('10'));
        context.h.ledger.setTokenDecimals(BID, 18);
        assertSuccess(await fundWith('10'));

        const short = await buy('alice', dust);
        assertSuccess(short);
        context.assert.strictEqual(JSON.parse(short.returnValue), 'underpaid');
        assertBalance(context.h.ledger, 'alice', BID, dust);
        assertContractBalance(context.h.ledger, ADDR, BID, '0');

        assertSuccess(await buy('bob', '100000.000000000000000001'));
        assertBalance(context.h.ledger, 'bob', BID, dust);
        assertBalance(context.h.ledger, SELLER, BID, '100000');
        assertContractBalance(context.h.ledger, ADDR, BID, '0');
    });
}

function registerExactCustodyAndPaymentCases(context) {
    // Custody and payment compare exactly: a tolerant gte admits up to 1e-12 relative
    // short, one base unit of an 8-decimal tick at 10000.
    describe('custody and payment checks are exact (no mathjs tolerance)', function () {
        it('payout guards use exact comparisons', function () {
            context.assert.doesNotMatch(context.CODE, /math\.gt\((held|excess), '0'\)/);
        });

        const helpers = createExactHelpers(context);
        registerFundShortCase(context, helpers);
        registerBuyShortCase(context, helpers);
        registerBidDustCase(context, helpers);
    });
}

module.exports = { registerExactCustodyAndPaymentCases };
