'use strict';

// A recorded contribution at or below the 1e-15 compare tolerance must still claim or
// refund (18-decimal pay tick), or withdraw() pays the owner for tokens never delivered.

// Build the per-test harness helpers for an 18-decimal pay tick.
function makeKit(ctx) {
    const { OWNER, B1, B2, ADDR, PAY, CODE, XChainVM, E2EHarness, assertSuccess } = ctx;
    const kit = { h: null };
    kit.deployAt = async function (rate, soft, hard, saleDecimals) {
        const h = kit.h = new E2EHarness(XChainVM);
        for (const a of [OWNER, B1, B2]) { h.seedBalance(a, 'XCHAIN', '1000000'); h.seedBalance(a, PAY, '500'); }
        h.ledger.setTokenDecimals(PAY, 18);
        assertSuccess(await h.deploy({ code: CODE, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, PAY, ctx.SALE, rate, soft, hard, '50', saleDecimals] }));
        kit.deadline = h.ledger.blockHeight + 50;
    };
    kit.buy = function (who, amount) {
        kit.h.deposit(who, ADDR, PAY, amount);
        return kit.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: who });
    };
    kit.call = function (method, who) {
        return kit.h.execute({ contractAddress: ADDR, method, params: [], caller: who });
    };
    kit.finalize = async function () {
        kit.h.ledger.blockHeight = kit.deadline;
        assertSuccess(await kit.call('finalize', B1));
        return kit.h.ledger.getContractStateKey(ADDR, 'status');
    };
    kit.state = function (key) { return kit.h.ledger.getContractStateKey(ADDR, key); };
    return kit;
}

function registerDustContributionTests(ctx, kit) {
    const { OWNER, B1, B2, ADDR, PAY, SALE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const DUST_RATE = '1000000000000000';

    describe('dust contributions below the compare tolerance', function () {
        it('a 1e-15 contribution claims its sale unit on success', async function () {
            await kit.deployAt(DUST_RATE, '0.001', '1', '0');
            assertSuccess(await kit.buy(B1, '0.0000000000000015'));
            assert.strictEqual(kit.state('c:' + B1), '0.000000000000001');
            assertSuccess(await kit.buy(B2, '0.001'));
            assert.strictEqual(await kit.finalize(), 'SUCCESS');
            const r = await kit.call('claim', B1);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'MINT', params: { tick: SALE, quantity: '1', destination: B1 } }]);
            assertSuccess(await kit.call('claim', B2));
            assertSuccess(await kit.call('withdraw', OWNER));
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });

        it('a 1e-15 contribution is refunded in full on failure', async function () {
            await kit.deployAt(DUST_RATE, '0.001', '1', '0');
            assertSuccess(await kit.buy(B1, '0.0000000000000015'));
            assert.strictEqual(await kit.finalize(), 'FAILED');
            const r = await kit.call('refund', B1);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND',
                params: { destination: B1, tick: PAY, quantity: '0.000000000000001' } }]);
            assertBalance(kit.h.ledger, B1, PAY, '500');
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });

        it('a mint of 2e-18 sale units still claims on an 18-decimal sale token', async function () {
            await kit.deployAt('0.001', '0.1', '1', '18');
            assertSuccess(await kit.buy(B1, '0.000000000000002'));
            assertSuccess(await kit.buy(B2, '0.5'));
            assert.strictEqual(await kit.finalize(), 'SUCCESS');
            const r = await kit.call('claim', B1);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'MINT',
                params: { tick: SALE, quantity: '0.000000000000000002', destination: B1 } }]);
        });

        it('a caller with no record still has nothing to claim or refund', async function () {
            await kit.deployAt(DUST_RATE, '0.001', '1', '0');
            assertSuccess(await kit.buy(B2, '0.001'));
            assert.strictEqual(await kit.finalize(), 'SUCCESS');
            assertReverted(await kit.call('claim', B1), 'nothing to claim');
            await kit.deployAt(DUST_RATE, '0.001', '1', '0');
            assert.strictEqual(await kit.finalize(), 'FAILED');
            assertReverted(await kit.call('refund', B1), 'nothing to refund');
        });
    });
}

module.exports = function registerDustContributionSuite(ctx) {
    registerDustContributionTests(ctx, makeKit(ctx));
};
