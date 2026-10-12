'use strict';

module.exports = function registerAttackTests(ctx) {
    const {
        ALICE, BOB, LIQ, ADDR, STABLE, assertSuccess, assertReverted, assertContractState, deployVault,
        setPrice, depositColl, borrow, repay, withdraw, liquidate
    } = ctx;

    describe('attacks we considered', function () {
        it('liquidating a healthy vault reverts', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            ctx.h.seedBalance(LIQ, STABLE, '200');
            assertReverted(await liquidate(LIQ, ALICE, '200'), 'vault is healthy');
        });

        it('a liquidation that does not cover the full debt reverts', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            setPrice('80');
            ctx.h.seedBalance(LIQ, STABLE, '150');
            assertReverted(await liquidate(LIQ, ALICE, '150'), 'must cover the full debt');
        });

        it('you cannot liquidate your own vault, nor a vault with no debt', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            setPrice('80');
            ctx.h.seedBalance(ALICE, STABLE, '200');
            assertReverted(await liquidate(ALICE, ALICE, '200'), 'cannot liquidate your own vault');
            ctx.h.seedBalance(LIQ, STABLE, '200');
            assertReverted(await liquidate(LIQ, BOB, '200'), 'vault has no debt');
        });

        it('a stale oracle blocks borrow/withdraw/liquidate but never deposit/repay', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '100');

            setPrice('100', 50); // snapshot 50 seconds old > maxSnapshotAge 10
            assertReverted(await borrow(ALICE, '10'), 'oracle price is stale');
            assertReverted(await withdraw(ALICE, '1'), 'oracle price is stale');
            ctx.h.seedBalance(LIQ, STABLE, '100');
            assertReverted(await liquidate(LIQ, ALICE, '100'), 'oracle price is stale');

            // De-risking must always work: deposit more, repay in full.
            assertSuccess(await depositColl(ALICE, '1'));
            assertSuccess(await repay(ALICE, '100'));
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
        });

        it('a stalled vault pair blocks borrow/withdraw/liquidate while the fleet snapshot is fresh', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '100');

            // Global snapshot age 0 (another pair just published), own round 50 s old.
            ctx.h.ledger.seedOracle(ctx.PAIR,
                { price: '100', roundNumber: 2, timestamp: ctx.h.ledger.blockTimestamp - 50 }, 0, {});
            ctx.h.ledger.seedOracle('SILVER/USD',
                { price: '25', roundNumber: 9, timestamp: ctx.h.ledger.blockTimestamp }, 0, {});
            assertReverted(await borrow(ALICE, '10'), 'oracle price is stale');
            assertReverted(await withdraw(ALICE, '1'), 'oracle price is stale');
            ctx.h.seedBalance(LIQ, STABLE, '100');
            assertReverted(await liquidate(LIQ, ALICE, '100'), 'oracle price is stale');

            assertSuccess(await depositColl(ALICE, '1'));
            assertSuccess(await repay(ALICE, '100'));
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
        });

        it('the pair round age bound is inclusive at maxSnapshotAge', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            ctx.h.ledger.seedOracle(ctx.PAIR,
                { price: '100', roundNumber: 2, timestamp: ctx.h.ledger.blockTimestamp - 10 }, 0, {});
            assertSuccess(await borrow(ALICE, '10'));
            ctx.h.ledger.seedOracle(ctx.PAIR,
                { price: '100', roundNumber: 3, timestamp: ctx.h.ledger.blockTimestamp - 11 }, 0, {});
            assertReverted(await borrow(ALICE, '10'), 'oracle price is stale');
        });

        it('a bare string price falls back to the global snapshot age alone', async function () {
            await deployVault();
            ctx.h.ledger.seedOracle(ctx.PAIR, '100', 0, {});
            await depositColl(ALICE, '3');
            assertSuccess(await borrow(ALICE, '10'));
        });

        it('borrow with an empty vault reverts', async function () {
            await deployVault();
            setPrice('100');
            assertReverted(await borrow(BOB, '1'), 'under-collateralized');
        });

        it('deposit without actually sending collateral reverts', async function () {
            await deployVault();
            const r = await ctx.h.execute({ contractAddress: ADDR, method: 'deposit', params: [], caller: ALICE });
            assertReverted(r, 'no collateral received');
        });
    });
};
