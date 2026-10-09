'use strict';

// Three properties of a funded grant: only the grantor starts the clock, an off-grid
// revoke leaves nothing behind in custody, and info() reports what claim() would pay.

// Build per-test helpers for an off-grid grant (8 over 3 blocks on a 0-decimal tick).
function makeKit(ctx) {
    const { GRANTOR, ADDR, TICK, BENE, CODE, XChainVM, E2EHarness, assertSuccess } = ctx;
    const kit = { h: null };
    kit.deploy = async function (total, duration, revocable, decimals) {
        kit.h = new E2EHarness(XChainVM);
        kit.h.seedBalance(GRANTOR, 'XCHAIN', '1000000');
        kit.h.seedBalance(GRANTOR, TICK, total);
        kit.h.ledger.setTokenDecimals(TICK, decimals);
        assertSuccess(await kit.h.deploy({ code: CODE, deployer: GRANTOR, contractAddress: ADDR,
            params: [GRANTOR, BENE, TICK, total, '0', String(duration), revocable] }));
        kit.base = kit.h.ledger.blockHeight;
    };
    kit.offGrid = async function (revocable) {
        await kit.deploy('8', 3, revocable, 0);
        kit.h.deposit(GRANTOR, ADDR, TICK, '8');
        assertSuccess(await kit.call('fund'));
    };
    kit.at = function (elapsed) { kit.h.ledger.blockHeight = kit.base + elapsed; };
    kit.call = function (method, who) {
        return kit.h.execute({ contractAddress: ADDR, method: method, params: [], caller: who || GRANTOR });
    };
    kit.parse = function (r) {
        assertSuccess(r);
        const v = JSON.parse(r.returnValue);
        return typeof v === 'string' ? JSON.parse(v) : v;
    };
    kit.info = async function () { return kit.parse(await kit.call('info', 'stranger')); };
    // Run info() the way the explorer's read-only simulation does: no balances, no token info.
    kit.simulateInfo = async function () {
        return kit.parse(await kit.h.vm.execute({
            code: kit.h.ledger.getContract(ADDR).code, state: kit.h.ledger.getContractState(ADDR),
            method: 'info', params: [], caller: 'simulation', contractAddress: ADDR,
            blockContext: kit.h.ledger.getBlockContext(), balances: null, tokenInfo: null
        }));
    };
    return kit;
}

function registerFundAccessTests(ctx, kit) {
    const { GRANTOR, BENE, STRANGER, ADDR, TICK, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance } = ctx;

    describe('fund() is grantor-only', function () {
        it('a beneficiary or stranger cannot fund, and the grantor still can', async function () {
            await kit.deploy('1000', 10, 'false', 8);
            kit.h.deposit(GRANTOR, ADDR, TICK, '1000');
            assertReverted(await kit.call('fund', BENE), 'only the grantor can fund');
            assertReverted(await kit.call('fund', STRANGER), 'only the grantor can fund');
            assert.strictEqual((await kit.info()).status, 'INIT');
            assertSuccess(await kit.call('fund'));
            assert.strictEqual((await kit.info()).status, 'ACTIVE');
        });

        it('a beneficiary fund() after a top-up cannot end the cancel window', async function () {
            await kit.deploy('1000', 10, 'false', 8);
            kit.h.deposit(GRANTOR, ADDR, TICK, '500');
            assertReverted(await kit.call('fund'), 'insufficient deposit');
            kit.h.deposit(GRANTOR, ADDR, TICK, '500');
            assertReverted(await kit.call('fund', BENE), 'only the grantor can fund');
            const r = await kit.call('cancel');
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: GRANTOR, tick: TICK, quantity: '1000' } }]);
            assertBalance(kit.h.ledger, GRANTOR, TICK, '1000');
        });
    });
}

function registerRevokeCapTests(ctx, kit) {
    const { GRANTOR, BENE, ADDR, TICK, assertSuccess, assertReverted, assertEmittedActions,
            assertBalance, assertContractBalance } = ctx;

    describe('revoke() cap: the two payouts sum to exactly total', function () {
        it('a claim before an off-grid revoke still drains custody to zero', async function () {
            await kit.offGrid('true');
            kit.at(1);                        // vested 2.666... -> pay 2
            let r = await kit.call('claim', BENE);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '2' } }]);
            kit.at(2);                        // vested 5.333..., unvested 2.666... -> grantor 2, cap 6
            r = await kit.call('revoke');
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: GRANTOR, tick: TICK, quantity: '2' } }]);
            kit.at(3);
            r = await kit.call('claim', BENE);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '4' } }]);
            assertBalance(kit.h.ledger, GRANTOR, TICK, '2');
            assertBalance(kit.h.ledger, BENE, TICK, '6');
            assertContractBalance(kit.h.ledger, ADDR, TICK, '0');
            assertReverted(await kit.call('claim', BENE), 'nothing to claim');
        });
    });
}

function registerInfoClaimableTests(ctx, kit) {
    const { BENE, TICK, assert, assertEmittedActions } = ctx;

    describe('info().claimable is what claim() would pay', function () {
        it('mid-schedule the view floors onto the grid like claim()', async function () {
            await kit.offGrid('false');
            kit.at(1);
            assert.strictEqual((await kit.info()).claimable, '2');
            const r = await kit.call('claim', BENE);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '2' } }]);
            assert.strictEqual((await kit.info()).claimable, '0');
        });

        it('after an off-grid revoke the view reaches zero with the last claim', async function () {
            await kit.offGrid('true');
            kit.at(1);
            await kit.call('revoke');
            assert.strictEqual((await kit.info()).claimable, '3');
            const r = await kit.call('claim', BENE);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '3' } }]);
            const i = await kit.info();
            assert.strictEqual(i.status, 'REVOKED');
            assert.strictEqual(i.claimable, '0');
        });

        it('the view floors without token info, as a read-only simulation runs it', async function () {
            await kit.offGrid('false');
            kit.at(1);
            assert.strictEqual((await kit.simulateInfo()).claimable, '2');
        });
    });
}

module.exports = function registerFundAccessAndRevokeCapTests(ctx) {
    const kit = makeKit(ctx);
    registerFundAccessTests(ctx, kit);
    registerRevokeCapTests(ctx, kit);
    registerInfoClaimableTests(ctx, kit);
};
