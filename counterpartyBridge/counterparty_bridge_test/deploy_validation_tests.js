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

    registerMaxSupplyGridTests(context);
};

// Deploy one fresh bridge per [maxSupply, decimals] pair and return each result by label.
async function deployEach(context, pairs) {
    const { HOLDER, CP_ASSET, XC_TICK, CODE, XChainVM, E2EHarness } = context;
    const out = [];
    for (const [cap, dec] of pairs) {
        const r = await new E2EHarness(XChainVM).deploy({
            code: CODE, deployer: HOLDER, contractAddress: 'C:BTC:5',
            params: [CP_ASSET, XC_TICK, cap, dec]
        });
        out.push({ label: cap + '@' + dec, r: r });
    }
    return out;
}

// The indexer rounds an off-grid pre-mint half-up, so custody and the cap would disagree.
function registerMaxSupplyGridTests(context) {
    const { assert } = context;

    describe('deploy-time maxSupply grid', function () {
        it('rejects a maxSupply carrying more fractional digits than decimals', async function () {
            const BAD = [['100.5', '0'], ['10.25', '1'], ['1.123456789', '8'], ['1.0000000000000000001', '18']];
            const accepted = (await deployEach(context, BAD))
                .filter(x => x.r.success || !String(x.r.error).includes('decimals grid'))
                .map(x => x.label + ' -> ' + (x.r.success ? 'deployed' : x.r.error));
            assert.deepStrictEqual(accepted, [], 'off-grid maxSupply values not refused by the grid gate');
        });

        it('accepts an on-grid maxSupply, trailing zeros included', async function () {
            const GOOD = [['100', '0'], ['100.50', '1'], ['1.12345678', '8'], ['100.000', '0']];
            const refused = (await deployEach(context, GOOD))
                .filter(x => !x.r.success)
                .map(x => x.label + ' -> ' + x.r.error);
            assert.deepStrictEqual(refused, [], 'on-grid maxSupply values refused');
        });
    });
}
