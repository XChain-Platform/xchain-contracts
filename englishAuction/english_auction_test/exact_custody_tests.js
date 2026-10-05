'use strict';

module.exports = function registerExactCustodyTests(tests) {
    const {
        XChainVM, E2EHarness, assertSuccess, assertReverted, assertBalance,
        assertContractState, CODE, SELLER, ITEM, BID, ADDR, env, depositAndFund, bid
    } = tests;

    // Custody and reserve compare exactly: a tolerant gte admits up to 1e-12 relative
    // short, one base unit of an 8-decimal tick at 10000.
    describe('custody and minimum-bid checks are exact (no mathjs tolerance)', function () {
        async function deployExact(itemAmount, minBid) {
            env.h = new E2EHarness(XChainVM);
            env.h.seedBalance(SELLER, 'XCHAIN', '1000000');
            env.h.seedBalance(SELLER, ITEM, '20000');
            env.h.ledger.setTokenDecimals(ITEM, 8);
            env.h.ledger.setTokenDecimals(BID, 8);
            return env.h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR,
                params: [SELLER, ITEM, itemAmount, BID, minBid, '3'] });
        }

        it('fund() rejects an item deposit one base unit short, and a top-up then settles exactly', async function () {
            assertSuccess(await deployExact('10000', '1'));
            assertReverted(await depositAndFund('9999.99999999'), 'insufficient item deposit');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
            assertSuccess(await depositAndFund('0.00000001'));
            assertContractState(env.h.ledger, ADDR, 'status', 'ACTIVE');
            assertSuccess(await bid('alice', '5'));
            env.h.mineBlock(); env.h.mineBlock(); env.h.mineBlock();
            assertSuccess(await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }));
            assertBalance(env.h.ledger, 'alice', ITEM, '10000');
        });

        it('bid() rejects a bid one base unit under a large minBid', async function () {
            assertSuccess(await deployExact('10', '10000'));
            assertSuccess(await depositAndFund('10'));
            assertReverted(await bid('alice', '9999.99999999'), 'bid below the minimum');
            assertContractState(env.h.ledger, ADDR, 'highBidder', null);
            // The rejected DEPOSIT stays in custody, so one more base unit makes exactly minBid.
            assertSuccess(await bid('bob', '0.00000001'));
            assertContractState(env.h.ledger, ADDR, 'highBid', '10000');
            assertContractState(env.h.ledger, ADDR, 'highBidder', 'bob');
        });

        it('an Infinity minBid never accepts a bid', async function () {
            assertSuccess(await deployExact('10', 'Infinity'));
            assertSuccess(await depositAndFund('10'));
            assertReverted(await bid('alice', '100'), 'bid below the minimum');
        });
    });
};
