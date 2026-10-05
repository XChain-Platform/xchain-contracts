'use strict';

module.exports = function registerAttackTests(tests) {
    const {
        XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
        assertBalance, assertContractBalance, assertContractState,
        CODE, SELLER, ITEM, BID, ADDR, env, deployAuction, depositAndFund, bid
    } = tests;

    describe('attacks we considered', function () {
        it('fund() rejects an underfunded item deposit', async function () {
            await deployAuction();
            assertReverted(await depositAndFund('5'), 'insufficient item deposit');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
        });

        it('only the seller can fund or cancel', async function () {
            await deployAuction();
            env.h.seedBalance('stranger', ITEM, '10');
            env.h.deposit('stranger', ADDR, ITEM, '10');
            assertReverted(await env.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: 'stranger' }),
                'only the seller');
            await depositAndFund();
            assertReverted(await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
                'only the seller');
        });

        it('a bid below the minimum is rejected', async function () {
            await deployAuction();
            await depositAndFund();
            assertReverted(await bid('alice', '10'), 'below the minimum');
            assertContractState(env.h.ledger, ADDR, 'highBid', '0');
        });

        it('a bid exactly equal to the minimum is accepted (minBid is inclusive)', async function () {
            await deployAuction();
            await depositAndFund();
            assertSuccess(await bid('alice', '50'));
            assertContractState(env.h.ledger, ADDR, 'highBid', '50');
            assertContractState(env.h.ledger, ADDR, 'highBidder', 'alice');
        });

        it('a bid that does not exceed the current high bid is rejected', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '80');
            assertReverted(await bid('bob', '80'), 'must exceed the current high bid');
            assertContractState(env.h.ledger, ADDR, 'highBidder', 'alice');
        });

        it('the current leader cannot raise their own bid', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await bid('alice', '100'), 'already the high bidder');
        });

        // Pins the documented COST of the no-self-raise rule (README, "A rejected
        // bid's DEPOSIT is not rolled back"). BATCH is not all-or-nothing, so the
        // top-up behind a reverting bid() settles anyway and the delta accounting
        // hands it to the NEXT bidder. A future change that refunds or credits it
        // instead must rewrite this test together with that README entry, not
        // delete it.
        it('a rejected bid strands its batched DEPOSIT, and the next bidder inherits it', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await bid('alice', '100'), 'already the high bidder');
            assertContractBalance(env.h.ledger, ADDR, BID, '150');   // alice's 100 settled anyway

            // bob deposits 10 and is credited 110: alice's stranded top-up plus his own.
            assertSuccess(await bid('bob', '10'));
            assertContractState(env.h.ledger, ADDR, 'highBidder', 'bob');
            assertContractState(env.h.ledger, ADDR, 'highBid', '110');
            assertBalance(env.h.ledger, 'alice', BID, '50');         // her 50 stake back, never the 100
        });

        it('bidding after the deadline is rejected; settle() is the only path', async function () {
            await deployAuction(2);
            await depositAndFund();
            env.h.mineBlock(); env.h.mineBlock();
            assertReverted(await bid('alice', '50'), 'bidding closed');
        });

        it('settle() before the deadline is rejected', async function () {
            await deployAuction(5);
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }),
                'deadline not reached');
        });

        it('cancel() is rejected once a bid has been placed', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
                'a bid has already been placed');
        });

        it('double-settle is impossible: second settle() reverts on the status guard', async function () {
            await deployAuction(2);
            await depositAndFund();
            await bid('alice', '50');
            env.h.mineBlock(); env.h.mineBlock();
            assertSuccess(await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }));
            assertReverted(await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }),
                'not active');
        });

        it('bidding before funding reverts', async function () {
            await deployAuction();
            assertReverted(await bid('alice', '50'), 'not active');
        });

        // settle() emits itemAmount VERBATIM and the indexer re-quantises every
        // emitted amount onto its tick's grid at write time. Off the grid that is
        // silent, and a zero amount is a VALID SEND that moves nothing: the winner
        // would pay in full and receive nothing while the deposit sat in a SOLD
        // auction with no cancel() left. The gate has to fire at fund(), before the
        // auction arms, because after that there is no path that refunds anyone.
        async function deployOffGridItem(itemAmount) {
            env.h = new E2EHarness(XChainVM);
            env.h.seedBalance(SELLER, 'XCHAIN', '1000000');
            env.h.seedBalance(SELLER, ITEM, '10');
            env.h.ledger.setTokenDecimals(ITEM, 0);
            return env.h.deploy({
                code: CODE, deployer: SELLER, contractAddress: ADDR,
                params: [SELLER, ITEM, itemAmount, BID, '50', '5']
            });
        }

        it('fund() rejects an itemAmount that is off the item tick grid', async function () {
            assertSuccess(await deployOffGridItem('0.25'));
            env.h.deposit(SELLER, ADDR, ITEM, '10');
            assertReverted(
                await env.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
                'not representable at itemTick decimals');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
            // Never armed, so no bid and no payment.
            assertReverted(await bid('alice', '50'), 'not active');
            // The rejecting fund() did NOT roll back the deposit, so cancel() from
            // the pre-funded state is the seller's recovery path. It returns the
            // HELD balance, not the off-grid itemAmount the ledger would re-quantise
            // to nothing.
            const c = await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(c);
            assertEmittedActions(c, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '10' } }]);
            assertBalance(env.h.ledger, SELLER, ITEM, '10');
            assertContractBalance(env.h.ledger, ADDR, ITEM, '0');
            assertContractState(env.h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('cancel() returns a short deposit after fund() rejected it', async function () {
            await deployAuction();
            assertReverted(await depositAndFund('5'), 'insufficient item deposit');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
            const c = await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(c);
            assertEmittedActions(c, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '5' } }]);
            assertBalance(env.h.ledger, SELLER, ITEM, '10');
            assertContractState(env.h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('a stranger cannot cancel() a pre-funded auction', async function () {
            await deployAuction();
            env.h.deposit(SELLER, ADDR, ITEM, '10');
            assertReverted(
                await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
                'only the seller');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
        });

        it('cancel() on a contract holding nothing reverts rather than latching CANCELLED', async function () {
            await deployAuction();
            assertReverted(
                await env.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
                'nothing to reclaim');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
            // Still fundable afterwards.
            assertSuccess(await depositAndFund());
            assertContractState(env.h.ledger, ADDR, 'status', 'ACTIVE');
        });

        it('an off-grid itemAmount above one unit is rejected too, not rounded up', async function () {
            assertSuccess(await deployOffGridItem('2.5'));
            env.h.deposit(SELLER, ADDR, ITEM, '10');
            assertReverted(
                await env.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
                'not representable at itemTick decimals');
            assertContractState(env.h.ledger, ADDR, 'status', 'INIT');
        });

        // The control the reject case needs: the gate must not refuse a legitimate
        // auction. Without this, a gate that reverted every fund() would look
        // identical to a gate that caught the defect.
        it('an on-grid itemAmount still funds, settles and delivers the exact quantity', async function () {
            await deployAuction(3);
            assertSuccess(await depositAndFund());
            assertContractState(env.h.ledger, ADDR, 'status', 'ACTIVE');
            assertSuccess(await bid('alice', '50'));
            env.h.mineBlock(); env.h.mineBlock(); env.h.mineBlock();
            const r = await env.h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertBalance(env.h.ledger, 'alice', ITEM, '10');
        });
    });
};
