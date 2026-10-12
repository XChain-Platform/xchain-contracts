'use strict';

// claim() floors paid * rate onto the sale grid, so buy() keeps only the part of an
// off-grid payment that buys whole sale units and returns the change to the buyer.

// Build the per-test harness helpers shared by the suites below.
function makeKit(ctx) {
    const { OWNER, B1, B2, ADDR, PAY, SALE, CODE, XChainVM, E2EHarness, assert,
            assertSuccess, assertEmittedActions } = ctx;
    const DURATION = 50;
    const kit = { h: null };
    kit.deployAt = async function (rate, soft, hard, saleDecimals) {
        const h = kit.h = new E2EHarness(XChainVM);
        for (const a of [OWNER, B1, B2]) { h.seedBalance(a, 'XCHAIN', '1000000'); h.seedBalance(a, PAY, '500'); }
        h.ledger.setTokenDecimals(PAY, 8);
        assertSuccess(await h.deploy({ code: CODE, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, PAY, SALE, rate, soft, hard, String(DURATION), saleDecimals] }));
        kit.deadline = h.ledger.blockHeight + DURATION;
    };
    kit.buy = function (who, amount) {
        kit.h.deposit(who, ADDR, PAY, amount);
        return kit.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: who });
    };
    kit.call = function (method, who) {
        return kit.h.execute({ contractAddress: ADDR, method, params: [], caller: who });
    };
    kit.change = function (r, who, quantity) {
        assertSuccess(r);
        assertEmittedActions(r, [{ action: 'SEND', params: { destination: who, tick: PAY, quantity } }]);
    };
    kit.minted = function (r, who, quantity) {
        assertSuccess(r);
        assertEmittedActions(r, [{ action: 'MINT', params: { tick: SALE, quantity, destination: who } }]);
    };
    kit.succeed = async function () {
        kit.h.ledger.blockHeight = kit.deadline;
        assertSuccess(await kit.call('finalize', B1));
        assert.strictEqual(kit.h.ledger.getContractStateKey(ADDR, 'status'), 'SUCCESS');
    };
    kit.state = function (key) { return kit.h.ledger.getContractStateKey(ADDR, key); };
    return kit;
}

function registerChangeTests(ctx, kit) {
    const { OWNER, B1, B2, ADDR, PAY, assertSuccess, assertReverted, assertBalance,
            assertContractBalance } = ctx;
    const { buy, call, change, minted, succeed } = kit;

    describe('off-grid payments: buy() returns the change', function () {
        it('a payment worth less than one sale unit comes back in full', async function () {
            await kit.deployAt('0.5', '1', '1000', '0');
            change(await buy(B1, '1'), B1, '1');
            assertBalance(kit.h.ledger, B1, PAY, '500');
            assertSuccess(await buy(B2, '10'));
            await succeed();
            assertReverted(await call('claim', B1), 'nothing to claim');
            minted(await call('claim', B2), B2, '5');
            assertSuccess(await call('withdraw', OWNER));
            assertBalance(kit.h.ledger, OWNER, PAY, '510');
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });

        it('the fractional part of a payment comes back and the rest mints exactly', async function () {
            await kit.deployAt('1', '1', '1000', '0');
            change(await buy(B1, '1.5'), B1, '0.5');
            await succeed();
            minted(await call('claim', B1), B1, '1');
            assertSuccess(await call('withdraw', OWNER));
            assertBalance(kit.h.ledger, OWNER, PAY, '501');
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });

        it('a top-up is priced on the running total', async function () {
            await kit.deployAt('1', '1', '1000', '0');
            change(await buy(B1, '1.5'), B1, '0.5');
            change(await buy(B1, '2.5'), B1, '0.5');
            await succeed();
            minted(await call('claim', B1), B1, '3');
        });

        it('a rate whose division never terminates keeps the smallest grid amount', async function () {
            await kit.deployAt('0.3', '1', '1000', '0');
            change(await buy(B1, '4'), B1, '0.66666666');
            await succeed();
            minted(await call('claim', B1), B1, '1');
            assertSuccess(await call('withdraw', OWNER));
            assertBalance(kit.h.ledger, OWNER, PAY, '503.33333334');
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });
    });
}

function registerCapRefundTests(ctx, kit) {
    const { B1, B2, ADDR, PAY, assert, assertSuccess, assertEmittedActions, assertBalance,
            assertContractBalance } = ctx;
    const { buy, call, change } = kit;

    describe('off-grid payments: caps, refunds and the on-grid path', function () {
        it('only the change past whole units is returned at the hard cap, which then closes early', async function () {
            await kit.deployAt('1', '1', '10', '0');
            assertSuccess(await buy(B1, '9'));
            change(await buy(B2, '1.5'), B2, '0.5');
            assert.strictEqual(kit.state('raised'), '10');
            assertSuccess(await call('finalize', B1));
        });

        it('a failed sale refunds the accepted amount, so every buyer ends where they began', async function () {
            await kit.deployAt('1', '100', '1000', '0');
            change(await buy(B1, '1.5'), B1, '0.5');
            change(await buy(B2, '2.25'), B2, '0.25');
            kit.h.ledger.blockHeight = kit.deadline;
            assertSuccess(await call('finalize', B1));
            assertSuccess(await call('refund', B1));
            assertSuccess(await call('refund', B2));
            assertBalance(kit.h.ledger, B1, PAY, '500');
            assertBalance(kit.h.ledger, B2, PAY, '500');
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });

        it('an on-grid payment returns nothing and is credited whole', async function () {
            await kit.deployAt('10', '1', '1000', '8');
            const r = await buy(B1, '60');
            assertSuccess(r);
            assertEmittedActions(r, []);
            assert.strictEqual(kit.state('c:' + B1), '60');
        });
    });
}

// Change at or below the 1e-15 compare tolerance must still leave custody (18-decimal pay tick).
function registerDustChangeTests(ctx, kit) {
    const { OWNER, B1, B2, ADDR, PAY, assert, assertSuccess, assertEmittedActions,
            assertContractBalance } = ctx;
    const { buy, call, change, succeed } = kit;

    describe('off-grid payments: change below the compare tolerance', function () {
        it('a 1e-18 change is sent back, so custody equals the accounted pay', async function () {
            await kit.deployAt('1', '1', '1000', '0');
            kit.h.ledger.setTokenDecimals(PAY, 18);
            change(await buy(B1, '1.000000000000000001'), B1, '0.000000000000000001');
            assert.strictEqual(kit.state('c:' + B1), '1');
            assert.strictEqual(kit.state('accountedPay'), '1');
            assertContractBalance(kit.h.ledger, ADDR, PAY, '1');
            const r = await buy(B2, '2');
            assertSuccess(r);
            assertEmittedActions(r, []);
            assert.strictEqual(kit.state('c:' + B2), '2');
            await succeed();
            assertSuccess(await call('withdraw', OWNER));
            assertContractBalance(kit.h.ledger, ADDR, PAY, '0');
        });
    });
}

// Exact decimal helpers for the cross-check below: a value scaled by 10^18 as a BigInt.
const SCALE = 18;
function big(v) {
    const [i, f = ''] = String(v).split('.');
    return BigInt(i + f.padEnd(SCALE, '0').slice(0, SCALE));
}
function unitsMinted(paid, rate, saleDec) {
    return (big(paid) * big(rate)) / (10n ** BigInt(2 * SCALE - saleDec));
}
function minusOneBaseUnit(v) {
    const s = (big(v) - 10n ** 10n).toString().padStart(SCALE + 1, '0');
    return s.slice(0, -SCALE) + '.' + s.slice(-SCALE);
}

function registerMinimumTests(ctx, kit) {
    const { B1, assert, assertSuccess } = ctx;
    const CASES = [
        ['0.3', '0', '4'], ['0.7', '0', '9.99999999'], ['1.5', '0', '2.33333333'],
        ['3', '1', '0.12345678'], ['0.123456789', '2', '17.5'], ['7.77', '0', '1.28'],
        ['0.00000003', '0', '99.99999999'], ['2', '0', '0.00000001'], ['0.9', '3', '1.11111111']
    ];

    describe('off-grid payments: accepted amount is the exact minimum', function () {
        for (const [rate, saleDec, paid] of CASES) {
            it('rate ' + rate + ', ' + saleDec + ' sale decimals, paying ' + paid, async function () {
                await kit.deployAt(rate, '0.00000001', '1000', saleDec);
                const r = await kit.buy(B1, paid);
                assertSuccess(r);
                const accepted = kit.state('c:' + B1) || '0';
                const sent = r.emittedActions.length ? r.emittedActions[0].params.quantity : '0';
                const d = parseInt(saleDec, 10);
                assert.strictEqual(big(accepted) + big(sent), big(paid), 'accepted + change != paid');
                assert.strictEqual(unitsMinted(accepted, rate, d), unitsMinted(paid, rate, d), 'accepted buys fewer units');
                if (big(accepted) > 0n)
                    assert(unitsMinted(minusOneBaseUnit(accepted), rate, d) < unitsMinted(paid, rate, d),
                        'accepted is not minimal');
            });
        }
    });
}

module.exports = function registerOffGridPaymentTests(ctx) {
    const kit = makeKit(ctx);
    registerChangeTests(ctx, kit);
    registerCapRefundTests(ctx, kit);
    registerDustChangeTests(ctx, kit);
    registerMinimumTests(ctx, kit);
};
