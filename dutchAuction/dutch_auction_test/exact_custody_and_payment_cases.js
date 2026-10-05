'use strict';

function registerExactCustodyAndPaymentCases(context) {
    const {
        ADDR, BID, CODE, E2EHarness, ITEM, SELLER, XChainVM,
        assertBalance, assertContractBalance, assertContractState,
        assertReverted, assertSuccess, buy
    } = context;

    // Custody and payment compare exactly: a tolerant gte admits up to 1e-12 relative
    // short, one base unit of an 8-decimal tick at 10000.
    describe('custody and payment checks are exact (no mathjs tolerance)', function () {
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

        it('fund() rejects an item deposit one base unit short, and a top-up then sells exactly', async function () {
            assertSuccess(await deployExact('10000'));
            assertReverted(await fundWith('9999.99999999'), 'insufficient item deposit');
            assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
            assertSuccess(await fundWith('0.00000001'));
            assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
            assertSuccess(await buy('alice', '100000'));
            assertBalance(context.h.ledger, 'alice', ITEM, '10000');
        });

        it('buy() rejects a payment one base unit short with the payment error, and exact pays the seller', async function () {
            assertSuccess(await deployExact('10'));
            assertSuccess(await fundWith('10'));
            assertReverted(await buy('alice', '99999.99999999'), 'insufficient payment for the current price (100000)');
            assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
            assertContractBalance(context.h.ledger, ADDR, BID, '99999.99999999');
            assertSuccess(await buy('bob', '0.00000001'));
            assertContractState(context.h.ledger, ADDR, 'buyer', 'bob');
            assertBalance(context.h.ledger, SELLER, BID, '100000');
        });
    });
}

module.exports = { registerExactCustodyAndPaymentCases };
