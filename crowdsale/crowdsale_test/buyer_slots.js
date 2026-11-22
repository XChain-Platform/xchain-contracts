'use strict';

// Distinct-buyer ceiling: every buyer holds one state key until claim or refund, so a
// new buyer past MAX_BUYERS is paid back in full before the VM key cap can revert buy().

const path = require('path');

const ANCHOR = 'var MAX_BUYERS = 9000;';

// Return the template source with its buyer ceiling replaced, refusing a renamed anchor.
function withCeiling(code, n) {
    if (code.split(ANCHOR).length !== 2) throw new Error('crowdsale.js no longer declares ' + ANCHOR);
    return code.replace(ANCHOR, 'var MAX_BUYERS = ' + n + ';');
}

function makeSlotKit(ctx) {
    const { OWNER, B1, B2, ADDR, PAY, SALE, XChainVM, E2EHarness, assertSuccess } = ctx;
    const kit = { h: null };
    kit.deploy = async function (code, maxStateKeys) {
        const over = maxStateKeys ? { limits: { maxStateKeys: maxStateKeys } } : undefined;
        const h = kit.h = new E2EHarness(XChainVM, over);
        for (const a of [OWNER, B1, B2, 'buyer3']) { h.seedBalance(a, 'XCHAIN', '1000000'); h.seedBalance(a, PAY, '500'); }
        h.ledger.setTokenDecimals(PAY, 8);
        assertSuccess(await h.deploy({ code: code, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, PAY, SALE, '10', '100', '200', '50', '8'] }));
        return Object.keys(h.ledger.getContractState(ADDR)).length;
    };
    kit.buy = function (who, amount) {
        kit.h.deposit(who, ADDR, PAY, amount);
        return kit.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: who });
    };
    kit.state = function (key) { return kit.h.ledger.getContractStateKey(ADDR, key); };
    return kit;
}

function registerBuyerSlotTests(ctx) {
    const { OWNER, B1, B2, ADDR, PAY, CODE, assert, assertSuccess, assertEmittedActions } = ctx;
    const B3 = 'buyer3';
    const kit = makeSlotKit(ctx);

    describe('distinct-buyer ceiling', function () {
        it('pays a new buyer past the ceiling back in full and credits no one else', async function () {
            // initialize()'s keys plus two buyer records fill the VM cap exactly.
            await kit.deploy(withCeiling(CODE, 2), 17);
            assertSuccess(await kit.buy(B1, '10'));
            assertSuccess(await kit.buy(B2, '10'));
            const r = await kit.buy(B3, '10');
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: B3, tick: PAY, quantity: '10' } }]);
            assert.strictEqual(kit.state('c:' + B3), null);
            assert.strictEqual(kit.state('accountedPay'), '20');
            assert.strictEqual(kit.state('buyers'), '2');
            // An existing buyer still adds to its record, and only its own payment counts.
            assertSuccess(await kit.buy(B1, '5'));
            assert.strictEqual(kit.state('c:' + B1), '15');
            assert.strictEqual(kit.state('raised'), '25');
        });

        it('without the ceiling the VM key cap reverts the new buyer and strands its deposit', async function () {
            // Control: the same cap with an unreachable ceiling shows the failure the ceiling prevents.
            await kit.deploy(withCeiling(CODE, 1000000), 17);
            assertSuccess(await kit.buy(B1, '10'));
            assertSuccess(await kit.buy(B2, '10'));
            const r = await kit.buy(B3, '10');
            assert.strictEqual(r.success, false);
            assert(String(r.error).includes('max state keys'), 'got: ' + r.error);
            assertSuccess(await kit.buy(B1, '5'));
            assert.strictEqual(kit.state('c:' + B1), '25');
        });

        it('keeps the shipped ceiling and initialize keys under the VM default key cap', async function () {
            const VM_DIR = path.join(__dirname, '..', '..', '..', 'xchain-vm');
            const { resolveLimits } = require(path.join(VM_DIR, 'src', 'index', 'runtime', 'limits_defaults.js'));
            const initKeys = await kit.deploy(CODE);
            assert(initKeys + 9000 < resolveLimits().maxStateKeys,
                initKeys + ' initialize keys plus 9000 buyers reach the VM key cap');
            // returnValue is the method's JSON string, itself JSON-encoded by the VM.
            const info = JSON.parse(JSON.parse((await kit.h.execute({ contractAddress: ADDR, method: 'info',
                params: [], caller: OWNER })).returnValue));
            assert.strictEqual(info.buyers, '0');
            assert.strictEqual(info.maxBuyers, '9000');
        });
    });
}

module.exports = registerBuyerSlotTests;
