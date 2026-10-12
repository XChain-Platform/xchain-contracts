'use strict';

module.exports = function registerDeployValidationTests(context) {
    const {
        assert, assertContractState, E2EHarness, XChainVM,
        GUARDIAN, GOV, ADDR, CODE, MIN_PROPOSE, TIMELOCK, WINDOW, deploy
    } = context;
    describe('deploy-time validation', function () {
        async function badDeploy(params) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(GUARDIAN, 'XCHAIN', '1000000');
            return b.deploy({ code: CODE, deployer: GUARDIAN, contractAddress: 'C:BTC:9', params });
        }

        it('rejects a zero timelock', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '0', '20', MIN_PROPOSE, 'guardian'])).success, false);
        });

        it('rejects an unknown mode', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '10', '20', MIN_PROPOSE, 'maybe'])).success, false);
        });

        it('rejects a zero proposal threshold', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '10', '20', '0', 'guardian'])).success, false);
        });

        it('rejects a missing guardian', async function () {
            assert.strictEqual((await badDeploy(['', GOV, '10', '20', MIN_PROPOSE, 'guardian'])).success, false);
        });

        // Integer-shape gate on timelockBlocks and executeWindowBlocks. Both are
        // raw deployer text, and a radix-less parseInt MEASURES them as something
        // else entirely: '1e3' is 1, '0x10' is 16, '7abc' is 7, ' 7' is 7, '5.99'
        // is 5. The old `parseInt(x) > 0` check then passed on the mis-measured
        // value, so a deployer asking for a 1000-block timelock via '1e3' silently
        // armed a 1-block one and defense #3 collapsed.
        it('rejects integer params a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                         '+7', '', 'abc', '-', 'Infinity', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await badDeploy([GUARDIAN, GOV, v, '20', MIN_PROPOSE, 'guardian'])).success, false,
                    `timelockBlocks ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await badDeploy([GUARDIAN, GOV, '10', v, MIN_PROPOSE, 'guardian'])).success, false,
                    `executeWindowBlocks ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('rejects integer params outside their range and stores accepted ones verbatim', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '10', '0', MIN_PROPOSE, 'guardian'])).success, false);
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '-10', '20', MIN_PROPOSE, 'guardian'])).success, false);
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '1000001', '20', MIN_PROPOSE, 'guardian'])).success, false);
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '10', '1000001', MIN_PROPOSE, 'guardian'])).success, false);
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '1000000', '1000000', MIN_PROPOSE, 'guardian'])).success, true);

            await deploy();
            assertContractState(context.h.ledger, ADDR, 'timelock', String(TIMELOCK));
            assertContractState(context.h.ledger, ADDR, 'exec_window', String(WINDOW));
        });
    });
};
