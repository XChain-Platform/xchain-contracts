'use strict';

module.exports = function registerDeployValidationTests(ctx) {
    const {
        assert, XChainVM, E2EHarness, CODE, ALICE, ADDR, COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE,
        assertContractState, deployVault
    } = ctx;

    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(ALICE, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: ALICE, contractAddress: 'C:BTC:2', params: params });
        }

        it('rejects a ratio at/below 100% and identical collateral/stable ticks', async function () {
            const low = await deployWith([COLL, STABLE, PAIR, '100', BONUS, MAXAGE]);
            assert.strictEqual(low.success, false, 'minRatioPct=100 should revert in initialize');
            const same = await deployWith([COLL, COLL, PAIR, RATIO, BONUS, MAXAGE]);
            assert.strictEqual(same.success, false, 'collateral == stable should revert in initialize');
        });

        // Integer-shape gate on maxSnapshotAge: a radix-less parseInt re-measures
        // '1e3' as 1, '0x10' as 16 and '7abc' as 7, so a deployer asking for a
        // 1000-block window would silently get a 1-block one.
        it('rejects a maxSnapshotAge a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                         '+7', '', 'abc', '-', 'Infinity', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([COLL, STABLE, PAIR, RATIO, BONUS, v])).success, false,
                    `maxSnapshotAge ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('rejects a maxSnapshotAge outside its range and stores an accepted one verbatim', async function () {
            assert.strictEqual((await deployWith([COLL, STABLE, PAIR, RATIO, BONUS, '0'])).success, false);
            assert.strictEqual((await deployWith([COLL, STABLE, PAIR, RATIO, BONUS, '-10'])).success, false);
            assert.strictEqual((await deployWith([COLL, STABLE, PAIR, RATIO, BONUS, '1000001'])).success, false);
            assert.strictEqual((await deployWith([COLL, STABLE, PAIR, RATIO, BONUS, '1000000'])).success, true);

            // '10' means 10 blocks in state, not the 1 a parseInt of '1e1' gave.
            await deployVault();
            assertContractState(ctx.h.ledger, ADDR, 'maxSnapshotAge', MAXAGE);
        });
    });
};
