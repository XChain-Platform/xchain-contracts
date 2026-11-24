'use strict';

// One base unit of an 18-decimal tick, and the 1e-15 absolute-tolerance edge, are
// real positive totals that a tolerant gt(.., '0') read as zero, so the DEPLOY of a
// dust grant reverted. initialize() tests the sign exactly; '0' still reverts.

function registerExactTotalCheck(ctx) {
    const { GRANTOR, BENE, TICK, CODE, XChainVM, E2EHarness, assert } = ctx;
    async function deployTotal(total, decimals) {
        const b = new E2EHarness(XChainVM);
        b.seedBalance(GRANTOR, 'XCHAIN', '1000000');
        b.ledger.setTokenDecimals(TICK, decimals);
        const r = await b.deploy({ code: CODE, deployer: GRANTOR, contractAddress: 'C:BTC:9',
            params: [GRANTOR, BENE, TICK, total, '10', '100', 'false'] });
        return { r, ledger: b.ledger };
    }

    describe('deploy-time total check is exact (no mathjs tolerance)', function () {
        it('accepts a total at or below the comparison tolerance of zero', async function () {
            for (const v of ['0.000000000000000001', '0.000000000000001']) {
                const { r, ledger } = await deployTotal(v, 18);
                assert.strictEqual(r.success, true, `total ${v} must deploy, got: ${r.error}`);
                assert.strictEqual(ledger.getContractStateKey('C:BTC:9', 'total'), v);
            }
        });

        it('still refuses a zero total as not positive', async function () {
            const { r } = await deployTotal('0', 18);
            assert.strictEqual(r.success, false);
            assert(String(r.error).includes('total must be positive'), 'got: ' + r.error);
        });
    });
}

module.exports = registerExactTotalCheck;
