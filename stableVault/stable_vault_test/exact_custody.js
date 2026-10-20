'use strict';

// A tolerant math.gte treats values within 1e-12 relative as equal, which at a
// 1,000,000 balance is a band of 100 base units on an 8-decimal tick.
module.exports = function registerExactCustodyTests(ctx) {
    const {
        ALICE, BOB, LIQ, ADDR, COLL, STABLE, assertSuccess, assertReverted, assertBalance,
        assertContractBalance, assertContractState, deployVault, setPrice, depositColl,
        borrow, repay, withdraw, liquidate
    } = ctx;

    describe('attacks we considered: exact custody at large balances', function () {
        it('a debt-free vault cannot withdraw one base unit more than its collateral', async function () {
            await deployVault();
            ctx.h.seedBalance(ALICE, COLL, '1000000');
            await depositColl(BOB, '10');
            await depositColl(ALICE, '1000000');
            assertReverted(await withdraw(ALICE, '1000000.00000001'), 'insufficient collateral');
            assertSuccess(await withdraw(ALICE, '1000000'));
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '0');
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '10');
            assertContractBalance(ctx.h.ledger, ADDR, COLL, '10');
            assertSuccess(await withdraw(BOB, '10'));
            assertBalance(ctx.h.ledger, BOB, COLL, '100');
        });

        it('a liquidation one base unit short of a large debt reverts', async function () {
            await deployVault();
            ctx.h.seedBalance(ALICE, COLL, '20000');
            setPrice('100');
            await depositColl(ALICE, '15000');
            assertSuccess(await borrow(ALICE, '1000000'));
            setPrice('99');
            ctx.h.seedBalance(LIQ, STABLE, '1000000');
            assertReverted(await liquidate(LIQ, ALICE, '999999.99999999'), 'must cover the full debt');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '1000000');
        });

        // At price 1.1 the owed collateral equals the debt, 5 base units above coll (inside the band).
        it('a liquidation never seizes more than the vault holds when owed is within the band', async function () {
            await deployVault();
            ctx.h.seedBalance(ALICE, COLL, '100000');
            await depositColl(BOB, '10');
            setPrice('100');
            await depositColl(ALICE, '100000');
            assertSuccess(await borrow(ALICE, '100000.00000005'));
            setPrice('1.1');
            ctx.h.seedBalance(LIQ, STABLE, '100000.00000005');
            assertSuccess(await liquidate(LIQ, ALICE, '100000.00000005'));
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '0');
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '10');
            assertContractBalance(ctx.h.ledger, ADDR, COLL, '10');
            assertBalance(ctx.h.ledger, LIQ, COLL, '100000');
            assertSuccess(await withdraw(BOB, '10'));
            assertBalance(ctx.h.ledger, BOB, COLL, '100');
        });

        it('a repay one base unit over a large debt refunds the excess and zeroes the debt', async function () {
            await deployVault();
            ctx.h.seedBalance(ALICE, COLL, '20000');
            setPrice('100');
            await depositColl(ALICE, '15000');
            assertSuccess(await borrow(ALICE, '1000000'));
            ctx.h.seedBalance(ALICE, STABLE, '1000000.00000001');
            const result = await repay(ALICE, '1000000.00000001');
            assertSuccess(result);
            ctx.assert.deepStrictEqual(result.emittedActions.map(a => [a.action, a.params.quantity]), [
                ['DESTROY', '1000000'],
                ['SEND', '0.00000001']
            ]);
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '0');
            assertBalance(ctx.h.ledger, ALICE, STABLE, '0.00000001');
        });
    });
};
