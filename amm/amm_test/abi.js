'use strict';

module.exports = function registerAbiTests(assert, abi) {
    describe('Template: amm abi', function () {
        it('declares an abi block covering every public method', function () {
            assert.strictEqual(abi.version, 1);
            assert.deepStrictEqual(Object.keys(abi.methods).sort(),
                ['addLiquidity', 'info', 'removeLiquidity', 'swap']);
        });

        it('declares swap params in wire order with valid types', function () {
            assert.deepStrictEqual(abi.methods.swap.params,
                [{ name: 'tokenIn', type: 'tick' }, { name: 'minOut', type: 'amount' }]);
            assert.deepStrictEqual(abi.methods.addLiquidity.params, []);
            assert.deepStrictEqual(abi.methods.removeLiquidity.params, []);
            assert.strictEqual(abi.methods.info.view, true);
        });
    });
};
