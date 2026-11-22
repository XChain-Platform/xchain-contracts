'use strict';

module.exports = function registerNotationGateTests(context) {
    const {
        assert, assertReverted, E2EHarness, XChainVM, GUARDIAN, GOV, HOLDER, PAYEE, PAY,
        CODE, deploy, call
    } = context;

    describe('notation gates run before any magnitude check', function () {
        async function deployWithMinPropose(minProp) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(GUARDIAN, 'XCHAIN', '1000000');
            return b.deploy({ code: CODE, deployer: GUARDIAN, contractAddress: 'C:BTC:9',
                params: [GUARDIAN, GOV, '10', '20', minProp, 'guardian'] });
        }

        // 'Infinity' passes a magnitude check, and no holder balance is then at least
        // it, so every propose() reverts and deposits can never leave the treasury.
        it('rejects a minProposeBalance that is not a plain decimal', async function () {
            const BAD = ['Infinity', '1e3', '0x10', '+5', '.5', '5.', '1_000', 'NaN', 'abc', '-5'];
            for (const v of BAD) {
                const r = await deployWithMinPropose(v);
                assert.strictEqual(r.success, false, `minProposeBalance ${JSON.stringify(v)} must not deploy`);
                assert.match(r.error, /minProposeBalance/, `minProposeBalance ${JSON.stringify(v)} names the param`);
            }
            assert.strictEqual((await deployWithMinPropose('0.5')).success, true);
        });

        // Text mathjs cannot parse gets the plain-decimal message, not a generic math error.
        it('reports an unparseable proposal amount with the plain-decimal message', async function () {
            await deploy();
            for (const v of ['abc', '1_000x']) {
                assertReverted(await call('propose', [PAYEE, PAY, v, 'memo'], HOLDER), 'plain decimal');
            }
            assertReverted(await call('propose', [PAYEE, PAY, '0', 'memo'], HOLDER), 'amount must be positive');
        });
    });
};
