'use strict';

function registerSaleGridTests(ctx, kit) {
    const { B1, ADDR, assert, assertSuccess, assertReverted } = ctx;

    describe('persisted sale-token grid', function () {
        it('buy() reverts when saleDecimals is corrupt', async function () {
            assertSuccess(await kit.deploy());
            kit.h.ledger.contractState[ADDR].saleDecimals = '8.5';

            assertReverted(await kit.buy(B1, '1'), 'saleDecimals must be an integer 0-18');
            assert.strictEqual(kit.h.ledger.getContractStateKey(ADDR, 'raised'), '0');
        });

        it('claim() reverts when saleDecimals is corrupt', async function () {
            assertSuccess(await kit.deploy());
            assertSuccess(await kit.buy(B1, '100'));
            kit.close();
            assertSuccess(await kit.call('finalize', B1));
            kit.h.ledger.contractState[ADDR].saleDecimals = '19';

            assertReverted(await kit.call('claim', B1), 'saleDecimals must be an integer 0-18');
            assert.strictEqual(kit.h.ledger.getContractStateKey(ADDR, 'c:' + B1), '100');
        });
    });
}

module.exports = registerSaleGridTests;
