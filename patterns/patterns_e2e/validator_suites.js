'use strict';

function registerIntegerSuite(ctx) {
    const { INTVALIDATOR, XChainVM, E2EHarness, OWNER, assert } = ctx;

    (XChainVM ? describe : describe.skip)('Patterns: requireIntInRange (integer-shape validation)', function () {
        this.timeout(0);
        async function deployWith(param) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(OWNER, 'XCHAIN', '1000000');
            return b.deploy({ code: INTVALIDATOR, deployer: OWNER, contractAddress: 'C:BTC:7', params: [param] });
        }
        it('accepts a canonical base-10 integer in range', async function () {
            assert.strictEqual((await deployWith('500')).success, true);
        });
        it('rejects non-integer / trailing-garbage / hex / whitespace shapes', async function () {
            for (const bad of ['5.99', '500abc', '0x100', ' 5', '', 'abc', '-'])
                assert.strictEqual((await deployWith(bad)).success, false, 'should reject ' + JSON.stringify(bad));
        });
        it('rejects an out-of-range integer', async function () {
            assert.strictEqual((await deployWith('0')).success, false);
            assert.strictEqual((await deployWith('2000000')).success, false);
        });
    });
}

function registerDecimalSuite(ctx) {
    const { DECIMALVALIDATOR, XChainVM, E2EHarness, OWNER, assert } = ctx;

    (XChainVM ? describe : describe.skip)('Patterns: requirePlainDecimal (notation validation)', function () {
        this.timeout(0);
        let n = 0;
        async function deployWith(param) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(OWNER, 'XCHAIN', '1000000');
            return b.deploy({ code: DECIMALVALIDATOR, deployer: OWNER, contractAddress: 'C:BTC:' + (100 + n++), params: [param] });
        }
        it('accepts plain fixed-notation decimals', async function () {
            for (const good of ['1', '100', '0.5', '0.00000001', '123456789.123456789'])
                assert.strictEqual((await deployWith(good)).success, true, 'should accept ' + JSON.stringify(good));
        });
        it('rejects the spellings requirePositive blesses and floorToDecimals corrupts', async function () {
            for (const bad of ['1.5e-8', '1.23456789e2', '0x10', 'Infinity', '+1', '.5'])
                assert.strictEqual((await deployWith(bad)).success, false, 'should reject ' + JSON.stringify(bad));
        });
        it('rejects malformed decimals outright', async function () {
            for (const bad of ['5.', '1.2.3', 'abc', '1 '])
                assert.strictEqual((await deployWith(bad)).success, false, 'should reject ' + JSON.stringify(bad));
        });
        it('is a NOTATION gate, not a grid check: a legitimately spelled off-grid value passes', async function () {
            assert.strictEqual((await deployWith('0.000000015')).success, true);
        });
    });
}

module.exports = function registerValidatorSuites(ctx) {
    registerIntegerSuite(ctx);
    registerDecimalSuite(ctx);
};
