'use strict';

module.exports = function registerFixedNotationAmountTests(ctx) {
    const {
        assert, ALICE, ADDR, STABLE, assertSuccess, assertReverted, assertBalance,
        assertContractBalance, assertContractState, deployVault, setPrice, depositColl, borrow,
        withdraw
    } = ctx;

    // borrow()/withdraw() take raw caller text, and floorToDecimals assumes
    // fixed notation: '1.5e-8' would skip flooring and book an off-grid value
    // while the indexer rounds the wire amount half-up, on every call.
    describe('non-fixed-notation amounts are rejected at the call seam', function () {
        const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                     '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                     'Infinity', 'NaN', '1.2.3'];

        it('borrow rejects every non-fixed-notation spelling of amount', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            for (const v of BAD) {
                const r = await borrow(ALICE, v);
                assert.strictEqual(r.success, false, `borrow(${JSON.stringify(v)}) must not succeed`);
                assert.strictEqual(r.emittedActions.length, 0,
                    `borrow(${JSON.stringify(v)}) must emit nothing`);
            }
            // Nothing was booked by any of them.
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '0');
            assertBalance(ctx.h.ledger, ALICE, STABLE, '0');
            // The plain-decimal gate, not an incidental mathjs throw, stops the one
            // spelling that would otherwise slip all the way through.
            assertReverted(await borrow(ALICE, '1.5e-8'), 'plain decimal');
        });

        it('withdraw rejects every non-fixed-notation spelling of amount', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            for (const v of BAD) {
                const r = await withdraw(ALICE, v);
                assert.strictEqual(r.success, false, `withdraw(${JSON.stringify(v)}) must not succeed`);
                assert.strictEqual(r.emittedActions.length, 0,
                    `withdraw(${JSON.stringify(v)}) must emit nothing`);
            }
            assertContractState(ctx.h.ledger, ADDR, 'trackedColl', '3');
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':coll', '3');
            assertReverted(await withdraw(ALICE, '1.5e-8'), 'plain decimal');
        });

        // The gate is notation only: an off-grid amount in fixed notation must
        // still go through and be floored, never locked out.
        it('still accepts ordinary fixed notation, off-grid values included', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            for (const v of ['1', '0.5', '100.00', '0.000000015']) {
                assertSuccess(await borrow(ALICE, v), `borrow(${JSON.stringify(v)}) must succeed`);
            }
            // 1 + 0.5 + 100 + floor(0.000000015) = 101.50000001, all on the grid.
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '101.50000001');
            assertBalance(ctx.h.ledger, ALICE, STABLE, '101.50000001');
            assertContractBalance(ctx.h.ledger, ADDR, STABLE, '0');
        });
    });
};
