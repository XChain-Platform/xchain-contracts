'use strict';

module.exports = function registerHappyPathTests(ctx) {
    const {
        assert, XChainVM, E2EHarness, CODE, ALICE, BOB, LIQ, ADDR, COLL, STABLE, PAIR, RATIO, BONUS,
        MAXAGE, assertSuccess, assertReverted, assertBalance, assertContractBalance,
        assertContractState, deployVault, setPrice, depositColl, borrow, repay, withdraw, liquidate
    } = ctx;

    describe('happy paths', function () {
        it('deposit collateral, borrow up to the ratio limit, not a unit more', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '3');

            // 3 GOLD * $100 * 100 = 30000 >= debt * 150  ->  max debt 200.
            assertSuccess(await borrow(ALICE, '200'));
            assertBalance(ctx.h.ledger, ALICE, STABLE, '200');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '200');
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '200');
            // Mint + send net out: no stable strands in custody.
            assertContractBalance(ctx.h.ledger, ADDR, STABLE, '0');

            assertReverted(await borrow(ALICE, '1'), 'under-collateralized');
        });

        it('repay burns the debt and refunds any excess stable', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            ctx.h.seedBalance(ALICE, STABLE, '250'); // 200 borrowed + 50 spare

            assertSuccess(await repay(ALICE, '250'));
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '0');
            assertBalance(ctx.h.ledger, ALICE, STABLE, '50');      // excess back
            assertContractBalance(ctx.h.ledger, ADDR, STABLE, '0'); // 200 burned
        });

        it('a debt-free vault withdraws everything without touching the oracle', async function () {
            await deployVault();
            // No setPrice on purpose: withdraw with zero debt must not read it.
            await depositColl(ALICE, '3');
            assertSuccess(await withdraw(ALICE, '3'));
            assertBalance(ctx.h.ledger, ALICE, COLL, '100');
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '0');
        });

        it('withdraw is allowed down to exactly the minimum ratio, blocked below it', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '5');
            await borrow(ALICE, '200');
            // 3 GOLD left * $100 * 100 = 30000 == 200 * 150: exactly at the line.
            assertSuccess(await withdraw(ALICE, '2'));
            assertReverted(await withdraw(ALICE, '1'), 'under-collateralized');
        });

        it('vaults are attributed per caller: two depositors never mix', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await depositColl(BOB, '5');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '3');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + BOB + ':coll', '5');
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '8');

            // Bob's collateral cannot back Alice's loan.
            assertReverted(await borrow(ALICE, '300'), 'under-collateralized');
            assertSuccess(await borrow(BOB, '300'));
        });

        it('price drop: anyone liquidates, seizes debt + bonus, owner keeps the rest', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');

            setPrice('80'); // 3 * 80 * 100 = 24000 < 200 * 150 = 30000 -> under water
            ctx.h.seedBalance(LIQ, STABLE, '200');

            assertSuccess(await liquidate(LIQ, ALICE, '200'));
            // Seized: 200 * 110 / (80 * 100) = 2.75 GOLD.
            assertBalance(ctx.h.ledger, LIQ, COLL, '2.75');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '0.25');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '0');
            assertContractBalance(ctx.h.ledger, ADDR, STABLE, '0'); // debt burned

            // The leftover 0.25 GOLD still belongs to Alice.
            assertSuccess(await withdraw(ALICE, '0.25'));
        });

        it('non-grid seizure is floored to the collateral decimals: custody == books', async function () {
            // 0-decimal collateral puts the raw seizure (2.75) off the grid; without
            // flooring, books record 2.75 while the indexer rounds half-up to 3,
            // leaving a pooled shortfall other vaults would eat.
            const COLL0 = 'IRON';
            ctx.h = new E2EHarness(XChainVM);
            ctx.h.seedBalance(ALICE, 'XCHAIN', '1000000');
            ctx.h.seedBalance(ALICE, COLL0, '100');
            ctx.h.ledger.setTokenDecimals(COLL0, 0);
            ctx.h.ledger.setTokenDecimals(STABLE, 8);
            await ctx.h.deploy({
                code: CODE, deployer: ALICE, contractAddress: ADDR,
                params: [COLL0, STABLE, PAIR, RATIO, BONUS, MAXAGE]
            });
            setPrice('100');
            ctx.h.deposit(ALICE, ADDR, COLL0, '3');
            assertSuccess(await ctx.h.execute({ contractAddress: ADDR, method: 'deposit', params: [], caller: ALICE }));
            assertSuccess(await borrow(ALICE, '200'));

            setPrice('80'); // raw seize = 200 * 110 / 8000 = 2.75, off the 0dp grid
            ctx.h.seedBalance(LIQ, STABLE, '200');
            assertSuccess(await liquidate(LIQ, ALICE, '200'));

            // Floored to 2 whole IRON; books and custody agree exactly.
            assertBalance(ctx.h.ledger, LIQ, COLL0, '2');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '1');
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '1');
            assert.strictEqual(ctx.h.ledger.getContractBalance(ADDR, COLL0) || '0', '1',
                'contract custody must equal trackedColl after a non-grid liquidation');

            // The invariant holds end-to-end: the owner can withdraw the full
            // remaining balance.
            assertSuccess(await withdraw(ALICE, '1'));
            assert.strictEqual(ctx.h.ledger.getContractBalance(ADDR, COLL0) || '0', '0');
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '0');
        });

        it('info() reports the system terms and totals', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '100');
            const r = await ctx.h.execute({ contractAddress: ADDR, method: 'info', params: [], caller: BOB });
            assertSuccess(r);
            const info = JSON.parse(JSON.parse(r.returnValue));
            assert.strictEqual(info.stableTick, STABLE);
            assert.strictEqual(info.totalDebt, '100');
            assert.strictEqual(info.trackedColl, '3');
        });
    });
};
