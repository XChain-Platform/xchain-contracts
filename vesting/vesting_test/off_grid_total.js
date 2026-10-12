'use strict';

// Payouts floor onto the tick's grid, so a total the grid cannot represent left at
// least one tick unit in custody for good. fund() now refuses it, and cancel() hands
// a refused (or short) deposit back to the grantor from the pre-funded state.

// Build the per-test harness helpers shared by both suites below.
function makeKit(ctx) {
    const { GRANTOR, BENE, STRANGER, ADDR, TICK, CODE, XChainVM, E2EHarness, assertSuccess } = ctx;
    const kit = { h: null };
    kit.deployAt = async function (decimals, total) {
        kit.h = new E2EHarness(XChainVM);
        kit.h.seedBalance(GRANTOR, 'XCHAIN', '1000000');
        kit.h.seedBalance(GRANTOR, TICK, '1000');
        kit.h.ledger.setTokenDecimals(TICK, decimals);
        assertSuccess(await kit.h.deploy({ code: CODE, deployer: GRANTOR, contractAddress: ADDR,
            params: [GRANTOR, BENE, TICK, total, '0', '10', 'false'] }));
        kit.base = kit.h.ledger.blockHeight;
    };
    kit.call = function (method, who) {
        return kit.h.execute({ contractAddress: ADDR, method: method, params: [], caller: who || GRANTOR });
    };
    kit.fundWith = function (amount) {
        kit.h.deposit(GRANTOR, ADDR, TICK, amount);
        return kit.call('fund');
    };
    kit.info = async function () {
        const r = await kit.call('info', STRANGER);
        assertSuccess(r);
        const v = JSON.parse(r.returnValue);
        return typeof v === 'string' ? JSON.parse(v) : v;
    };
    return kit;
}

function registerOffGridFundTests(ctx, kit) {
    const { GRANTOR, BENE, ADDR, TICK, assert, assertSuccess, assertReverted, assertEmittedActions,
            assertBalance, assertContractBalance } = ctx;

    describe('off-grid total is refused at fund()', function () {
        it('a 1.5 grant on a 0-decimal tick never goes live, and cancel() returns the deposit', async function () {
            await kit.deployAt(0, '1.5');
            assertReverted(await kit.fundWith('2'), 'not representable');
            const r = await kit.call('cancel');
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: GRANTOR, tick: TICK, quantity: '2' } }]);
            assertContractBalance(kit.h.ledger, ADDR, TICK, '0');
            assertBalance(kit.h.ledger, GRANTOR, TICK, '1000');
            const i = await kit.info();
            assert.strictEqual(i.status, 'CANCELLED');
            assert.strictEqual(i.claimable, '0');
            assertReverted(await kit.fundWith('2'), 'vesting not awaiting funds');
            assertReverted(await kit.call('claim', BENE), 'vesting not active');
            assertReverted(await kit.call('cancel'), 'vesting not cancellable');
        });

        it('a 9-place total on an 8-decimal tick is refused', async function () {
            await kit.deployAt(8, '1.000000001');
            assertReverted(await kit.fundWith('1.00000001'), 'not representable');
        });

        it('a total spelled with trailing zeros but on the grid still funds and drains', async function () {
            await kit.deployAt(0, '2.0');
            assertSuccess(await kit.fundWith('2'));
            kit.h.ledger.blockHeight = kit.base + 10;
            assertSuccess(await kit.call('claim', BENE));
            assertContractBalance(kit.h.ledger, ADDR, TICK, '0');
        });
    });
}

function registerCancelTests(ctx, kit) {
    const { GRANTOR, BENE, STRANGER, ADDR, TICK, assertSuccess, assertReverted, assertEmittedActions,
            assertBalance, assertContractBalance } = ctx;

    describe('cancel() from the pre-funded state', function () {
        it('returns exactly a short deposit after an insufficient-deposit refusal', async function () {
            await kit.deployAt(8, '1000');
            assertReverted(await kit.fundWith('500'), 'insufficient deposit');
            const r = await kit.call('cancel');
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: GRANTOR, tick: TICK, quantity: '500' } }]);
            assertBalance(kit.h.ledger, GRANTOR, TICK, '1000');
        });

        it('is grantor-only, INIT-only, and refuses an empty contract', async function () {
            await kit.deployAt(8, '1000');
            assertReverted(await kit.call('cancel'), 'nothing to reclaim');
            kit.h.deposit(GRANTOR, ADDR, TICK, '1000');
            assertReverted(await kit.call('cancel', STRANGER), 'only the grantor can cancel');
            assertReverted(await kit.call('cancel', BENE), 'only the grantor can cancel');
            assertSuccess(await kit.call('fund'));
            assertReverted(await kit.call('cancel'), 'vesting not cancellable');
            assertContractBalance(kit.h.ledger, ADDR, TICK, '1000');
        });
    });
}

module.exports = function registerOffGridTotalTests(ctx) {
    const kit = makeKit(ctx);
    registerOffGridFundTests(ctx, kit);
    registerCancelTests(ctx, kit);
};
