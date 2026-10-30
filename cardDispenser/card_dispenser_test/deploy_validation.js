'use strict';

function registerBasicValidation(ctx) {
    const { PAY, PRICE, UNIT, A, assert, bareDeploy } = ctx;
    it('rejects a deploy with no card ticks', async function () {
        const { r } = await bareDeploy('C:BTC:2', [PAY, PRICE, UNIT]);
        assert.strictEqual(r.success, false, 'deploy without cards should revert in initialize');
    });

    it('rejects a non-positive price', async function () {
        const { r } = await bareDeploy('C:BTC:3', [PAY, '0', UNIT, A]);
        assert.strictEqual(r.success, false, 'deploy with price=0 should revert in initialize');
    });
}

function registerUnitNotation(ctx) {
    const { PAY, PRICE, A, assert, assertSuccess, assertContractState, bareDeploy } = ctx;
    it('rejects a unit that is not a plain fixed-notation decimal', async function () {
        const BAD = ['2.5e-1', '1e3', '0x10', '+1.5', '.5', '5.', '1_000',
                     '1.2.3', '', ' 1', 'abc', '-1'];
        for (let i = 0; i < BAD.length; i++) {
            const { r } = await bareDeploy('C:BTC:4', [PAY, PRICE, BAD[i], A]);
            assert.strictEqual(r.success, false,
                'deploy with unit ' + JSON.stringify(BAD[i]) + ' should revert');
        }
    });

    it('accepts an off-grid but plainly spelled unit and stores it verbatim', async function () {
        const { r, ledger } = await bareDeploy('C:BTC:5', [PAY, PRICE, '0.25', A]);
        assertSuccess(r);
        assertContractState(ledger, 'C:BTC:5', 'unit', '0.25');
    });
}

function registerPriceNotation(ctx) {
    const { PAY, UNIT, A, assert, bareDeploy } = ctx;
    it('rejects a price that is not a plain fixed-notation decimal', async function () {
        const BAD = ['1e3', '0x10', '+1.5', '.5', '5.', '1_000', 'Infinity'];
        const accepted = [];
        for (let i = 0; i < BAD.length; i++) {
            const { r } = await bareDeploy('C:BTC:6', [PAY, BAD[i], UNIT, A]);
            if (r.success || !String(r.error).includes('price'))
                accepted.push(BAD[i] + ' -> ' + (r.success ? 'deployed' : r.error));
        }
        assert.deepStrictEqual(accepted, [], 'price spellings not refused by the price gate');
    });
}

module.exports = function registerDeployValidationTests(ctx) {
    registerBasicValidation(ctx);
    registerUnitNotation(ctx);
    registerPriceNotation(ctx);
};
