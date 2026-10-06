'use strict';

function registerPurchaseCases(context) {
    const {
        ADDR, BID, ITEM, SELLER, assertBalance, assertContractBalance,
        assertContractState, assertEmittedActions, assertReverted,
        assertSuccess, buy, deployAuction, depositAndFund
    } = context;

    it('buying at deploy-time price (block 0 elapsed) charges startPrice', async function () {
        await deployAuction(10);
        await depositAndFund(); // fund() lands the block right after deploy; elapsed = 0
        const r = await buy('alice', '1000');
        assertSuccess(r);
        assertEmittedActions(r, [
            { action: 'SEND', params: { destination: 'alice', tick: ITEM, quantity: '10' } },
            { action: 'SEND', params: { destination: SELLER, tick: BID, quantity: '1000' } }
        ]);
        assertBalance(context.h.ledger, 'alice', ITEM, '10');
        assertBalance(context.h.ledger, SELLER, BID, '1000');
        assertContractState(context.h.ledger, ADDR, 'status', 'SOLD');
    });

    it('the price decays linearly with elapsed blocks', async function () {
        await deployAuction(10); // 1000 -> 100 over 10 blocks = 90/block
        await depositAndFund();
        context.h.mineBlock(); context.h.mineBlock(); context.h.mineBlock(); // elapsed = 3 -> price 1000 - 270 = 730
        assertReverted(await buy('alice', '700'), 'insufficient payment for the current price (730)');
        const r = await buy('alice', '730');
        assertSuccess(r);
        assertBalance(context.h.ledger, SELLER, BID, '730');
    });

    it('overpaying refunds the excess in the same call', async function () {
        await deployAuction(10);
        await depositAndFund();
        const r = await buy('alice', '1000'); // price is 1000 at elapsed=0; no excess
        assertSuccess(r);
        assertContractBalance(context.h.ledger, ADDR, BID, '0');

        await deployAuction(10);
        await depositAndFund();
        const r2 = await buy('bob', '1500'); // overpay by 500
        assertSuccess(r2);
        assertEmittedActions(r2, [
            { action: 'SEND', params: { destination: 'bob', tick: ITEM, quantity: '10' } },
            { action: 'SEND', params: { destination: SELLER, tick: BID, quantity: '1000' } },
            { action: 'SEND', params: { destination: 'bob', tick: BID, quantity: '500' } }
        ]);
        assertBalance(context.h.ledger, 'bob', BID, '500'); // 1500 sent - 1000 charged = 500 back
    });
}

function registerPriceFloorAndCancelCases(context) {
    const {
        ADDR, BID, ITEM, SELLER, assertBalance, assertContractState,
        assertReverted, assertSuccess, buy, deployAuction, depositAndFund
    } = context;

    it('the price floors at endPrice and holds there indefinitely', async function () {
        await deployAuction(10);
        await depositAndFund();
        for (let i = 0; i < 50; i++) context.h.mineBlock(); // way past duration
        assertReverted(await buy('alice', '99'), 'insufficient payment for the current price (100)');
        const r = await buy('alice', '100');
        assertSuccess(r);
        assertBalance(context.h.ledger, SELLER, BID, '100');
    });

    it('seller cancels before any purchase and reclaims the item', async function () {
        await deployAuction(10);
        await depositAndFund();
        context.h.mineBlock();
        const r = await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
        assertSuccess(r);
        assertBalance(context.h.ledger, SELLER, ITEM, '10');
        assertContractState(context.h.ledger, ADDR, 'status', 'CANCELLED');
    });
}

function registerHappyPathCases(context) {
    describe('happy paths', function () {
        registerPurchaseCases(context);
        registerPriceFloorAndCancelCases(context);
    });
}

module.exports = { registerHappyPathCases };
