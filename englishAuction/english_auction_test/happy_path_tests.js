'use strict';

module.exports = function registerHappyPathTests(tests) {
    const {
        assertSuccess, assertEmittedActions, assertBalance, assertContractBalance,
        assertContractState, SELLER, ITEM, BID, ADDR, env, deployAuction,
        depositAndFund, bid
    } = tests;

    describe('happy paths', function () {
        it('a single bidder wins the item and the seller is paid, after the deadline', async function () {
            await deployAuction(3);
            assertSuccess(await depositAndFund());
            assertContractState(env.h.ledger, ADDR, 'status', 'ACTIVE');

            assertSuccess(await bid('alice', '50'));
            assertContractState(env.h.ledger, ADDR, 'highBidder', 'alice');
            assertContractState(env.h.ledger, ADDR, 'highBid', '50');

            env.h.mineBlock(); env.h.mineBlock(); env.h.mineBlock();
            const r = await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'alice', tick: ITEM, quantity: '10' } },
                { action: 'SEND', params: { destination: SELLER, tick: BID, quantity: '50' } }
            ]);
            assertBalance(env.h.ledger, 'alice', ITEM, '10');
            assertBalance(env.h.ledger, SELLER, BID, '50');
            assertContractBalance(env.h.ledger, ADDR, ITEM, '0');
            assertContractBalance(env.h.ledger, ADDR, BID, '0');
            assertContractState(env.h.ledger, ADDR, 'status', 'SOLD');
        });

        it('a higher bid instantly refunds the previous leader', async function () {
            await deployAuction();
            await depositAndFund();
            assertSuccess(await bid('alice', '50'));
            const r = await bid('bob', '80');
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: 'alice', tick: BID, quantity: '50' } }]);
            assertBalance(env.h.ledger, 'alice', BID, '50'); // fully refunded
            assertContractBalance(env.h.ledger, ADDR, BID, '80'); // only bob's stake held
            assertContractState(env.h.ledger, ADDR, 'highBidder', 'bob');
            assertContractState(env.h.ledger, ADDR, 'highBid', '80');
        });

        it('multiple raises settle correctly: item to the final leader, bid to the seller', async function () {
            await deployAuction(3);
            await depositAndFund();
            await bid('alice', '50');
            await bid('bob', '80');
            await bid('carol', '120');
            env.h.mineBlock(); env.h.mineBlock(); env.h.mineBlock();
            const r = await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertBalance(env.h.ledger, 'carol', ITEM, '10');
            assertBalance(env.h.ledger, SELLER, BID, '120');
            assertBalance(env.h.ledger, 'alice', BID, '50'); // refunded when outbid by bob
            assertBalance(env.h.ledger, 'bob', BID, '80'); // refunded when outbid by carol
        });

        it('no bids: settle() returns the item to the seller (UNSOLD)', async function () {
            await deployAuction(3);
            await depositAndFund();
            env.h.mineBlock(); env.h.mineBlock(); env.h.mineBlock();
            const r = await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '10' } }]);
            assertBalance(env.h.ledger, SELLER, ITEM, '10');
            assertContractState(env.h.ledger, ADDR, 'status', 'UNSOLD');
        });

        it('seller cancels before any bid and reclaims the item', async function () {
            await deployAuction();
            await depositAndFund();
            const r = await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(r);
            assertBalance(env.h.ledger, SELLER, ITEM, '10');
            assertContractState(env.h.ledger, ADDR, 'status', 'CANCELLED');
        });
    });
};
