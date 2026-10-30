'use strict';

function registerTermValidation(ctx, deployWith) {
    const { MAKER, PAIR, STRIKE, TICK, STAKE, assert } = ctx;
    const terms = (stake, strike, round, window) =>
        [MAKER, PAIR, strike || STRIKE, 'OVER', TICK, stake || STAKE, round || '7', window || '5'];
    const deploys = async (params) => (await deployWith(params)).success;
    it('rejects an invalid side', async function () {
        const r = await deployWith([MAKER, PAIR, STRIKE, 'ABOVE', TICK, STAKE, '7', '5']);
        assert.strictEqual(r.success, false, 'side=ABOVE should revert in initialize');
    });
    it('rejects a non-positive stake and a non-positive round', async function () {
        assert.strictEqual(await deploys(terms('0')), false);
        assert.strictEqual(await deploys(terms(STAKE, STRIKE, '0')), false);
    });
    it('rejects every non-fixed-notation spelling of stake and strike', async function () {
        const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                     '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                     'Infinity', 'NaN', '1.2.3'];
        for (const v of BAD) {
            assert.strictEqual(await deploys(terms(v)), false, `stake ${JSON.stringify(v)} must not deploy`);
            assert.strictEqual(await deploys(terms(STAKE, v)), false, `strike ${JSON.stringify(v)} must not deploy`);
        }
    });
    it('still accepts ordinary fixed-notation terms, trailing zeros included', async function () {
        for (const v of ['100', '0.5', '60000.00', '0.000000015', '999999999999'])
            assert.strictEqual(await deploys(terms(v)), true, `stake ${JSON.stringify(v)} must deploy`);
    });
    it('names the plain-decimal rule for an unparseable stake or strike', async function () {
        for (const params of [terms('abc'), terms(STAKE, 'abc')]) {
            const r = await deployWith(params);
            assert.strictEqual(r.success, false);
            assert.ok(/plain decimal/.test(String(r.error)), 'unexpected revert: ' + r.error);
        }
    });
}

function registerIntegerValidation(ctx, deployWith) {
    const { MAKER, PAIR, STRIKE, TICK, STAKE, ROUND, assert, deployBet, state } = ctx;
    const deploys = async (round, window) =>
        (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, round, window])).success;
    it('rejects integer params a radix-less parseInt would silently re-measure', async function () {
        const BAD = ['1e2', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                     '+7', '', 'abc', '-', 'Infinity', 'NaN'];
        for (const v of BAD) {
            assert.strictEqual(await deploys(v, '5'), false, `settleRound ${JSON.stringify(v)} must not deploy`);
            assert.strictEqual(await deploys('7', v), false, `deadlineBlocks ${JSON.stringify(v)} must not deploy`);
        }
    });
    it('rejects integer params outside their range and stores accepted ones verbatim', async function () {
        assert.strictEqual(await deploys('7', '0'), false);
        assert.strictEqual(await deploys('-7', '5'), false);
        assert.strictEqual(await deploys('1000000001', '5'), false);
        assert.strictEqual(await deploys('7', '1000001'), false);
        assert.strictEqual(await deploys('1000000000', '1000000'), true);
        await deployBet('OVER', 100);
        state('window', '100'); state('settleRound', String(ROUND));
    });
}

module.exports = function registerDeployValidationSuite(ctx) {
    const { MAKER, CODE, XChainVM, E2EHarness } = ctx;
    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(MAKER, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: MAKER, contractAddress: 'C:BTC:2', params });
        }
        registerTermValidation(ctx, deployWith);
        registerIntegerValidation(ctx, deployWith);
    });
};
