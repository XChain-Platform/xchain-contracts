'use strict';

module.exports = function registerDeployValidationTests(context) {
    const {
        HOLDER, CP_ASSET, XC_TICK, MAX_SUPPLY, CODE, XChainVM, E2EHarness,
        assert
    } = context;

    describe('deploy-time validation', function () {
        it('rejects an empty cpAsset', async function () {
            const bad = new E2EHarness(XChainVM);
            const r = await bad.deploy({
                code: CODE, deployer: HOLDER, contractAddress: 'C:BTC:2',
                params: ['', XC_TICK, MAX_SUPPLY, '8']
            });
            assert.strictEqual(r.success, false, 'deploy with an empty cpAsset should revert in initialize');
        });

        it('rejects an out-of-range decimals value', async function () {
            const bad = new E2EHarness(XChainVM);
            const r = await bad.deploy({
                code: CODE, deployer: HOLDER, contractAddress: 'C:BTC:3',
                params: [CP_ASSET, XC_TICK, MAX_SUPPLY, '19']
            });
            assert.strictEqual(r.success, false, 'deploy with decimals > 18 should revert in initialize');
        });
    });
};
