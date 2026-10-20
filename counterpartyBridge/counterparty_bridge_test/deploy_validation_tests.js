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

        // maxSupply is emitted verbatim into the ISSUE, and every spelling here passes
        // the > 0 magnitude check, so only the notation gate can refuse it in-contract.
        it('rejects a maxSupply that is not a plain fixed-notation decimal', async function () {
            const BAD = ['1e8', '0x10', '+1.5', '.5', '5.', '1_000', 'Infinity'];
            const accepted = [];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                const r = await bad.deploy({
                    code: CODE, deployer: HOLDER, contractAddress: 'C:BTC:4',
                    params: [CP_ASSET, XC_TICK, BAD[i], '8']
                });
                if (r.success || !String(r.error).includes('maxSupply')) accepted.push(BAD[i] + ' -> ' + (r.success ? 'deployed' : r.error));
            }
            assert.deepStrictEqual(accepted, [], 'maxSupply spellings not refused by the maxSupply gate');
        });
    });
};
