'use strict';

// Credit and pending ceilings measured against a real VM key cap. The template
// runs with shrunken ceilings under a harness maxStateKeys that the ceilings
// exactly fill, so a counter that drifts from the live key count, or a ceiling
// test that is off by one, reverts here on 'max state keys'.

const path = require('path');

const CREDIT_ANCHOR = 'var MAX_CREDIT_KEYS = 9000;';
const PENDING_ANCHOR = 'var MAX_PENDING = 900;';
const THIRD = '1ThirdBtcAddress33333333333333333';

// Return the template source with both ceilings replaced, refusing a renamed anchor.
function withCeilings(code, credit, pending) {
    for (const anchor of [CREDIT_ANCHOR, PENDING_ANCHOR]) {
        if (code.split(anchor).length !== 2) throw new Error('counterpartyBridge.js no longer declares ' + anchor);
    }
    return code.replace(CREDIT_ANCHOR, 'var MAX_CREDIT_KEYS = ' + credit + ';')
        .replace(PENDING_ANCHOR, 'var MAX_PENDING = ' + pending + ';');
}

function makeKit(ctx) {
    const { ADDR, HOLDER, CP_ASSET, XC_TICK, MAX_SUPPLY, XChainVM, E2EHarness, assert, sendsPayload } = ctx;
    const kit = { h: null };
    // Deploys once uncapped to measure initialize()'s keys, then again under a VM
    // key cap of those keys plus `extraKeys` when extraKeys is given.
    kit.deploy = async function (code, extraKeys) {
        let initKeys = null;
        for (const cap of extraKeys === undefined ? [null] : [null, 'cap']) {
            const over = cap ? { limits: { maxStateKeys: initKeys + extraKeys } } : undefined;
            const h = kit.h = new E2EHarness(XChainVM, over);
            const deployed = await h.deploy({ code: code, deployer: HOLDER, contractAddress: ADDR,
                params: [CP_ASSET, XC_TICK, MAX_SUPPLY, '8'] });
            assert.strictEqual(deployed.success, true, 'bridge deploy failed: ' + deployed.error);
            h.ledger.creditContractBalance(ADDR, XC_TICK, MAX_SUPPLY);
            initKeys = Object.keys(h.ledger.getContractState(ADDR)).length;
        }
        return initKeys;
    };
    kit.request = function (who) {
        return kit.h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: who });
    };
    kit.settle = function (who, id, hashes) {
        kit.h.ledger.seedAttestation(id, { status: 'ok', providerId: 'http_get', blockIndex: 200, validatorCount: 3,
            payload: sendsPayload(hashes.map(txHash => ({ txHash: txHash, quantity: '1', source: who }))) });
        return kit.h.execute({ contractAddress: ADDR, method: 'onClaim', params: [id, 'http_get', 'ok', '', who], caller: who });
    };
    kit.expire = function (who, id) {
        return kit.h.execute({ contractAddress: ADDR, method: 'onClaim', params: [id, 'http_get', 'expired', '', who], caller: ADDR });
    };
    // Counters kept by the contract beside the keys they are meant to count.
    kit.counts = function () {
        const state = kit.h.ledger.getContractState(ADDR);
        const keys = Object.keys(state);
        const live = prefix => keys.filter(k => k.indexOf(prefix) === 0).length;
        return { creditKeys: state.creditKeys, credit: String(live('burned:') + live('claimedTotal:')),
            pendingCount: state.pendingCount, pending: String(live('pending:')) };
    };
    return kit;
}

async function claimOk(ctx, kit, who, hashes) {
    const req = await kit.request(who);
    ctx.assertSuccess(req);
    return kit.settle(who, JSON.parse(req.returnValue), hashes);
}

module.exports = function registerKeyCapacityTests(ctx) {
    describe('state-key ceilings under a real VM key cap', function () {
        registerCreditCeilingTests(ctx);
        registerPendingCeilingTests(ctx);
    });
};

function registerCreditCeilingTests(ctx) {
    const { assert, HOLDER, CODE, assertSuccess, assertReverted, assertEmittedActions, nextTxHash } = ctx;
    const kit = makeKit(ctx);

    it('pays a claim that exactly fills the credit ceiling and fails soft one claim past it', async function () {
        await kit.deploy(withCeilings(CODE, 4, 1), 4 + 1);
        assertSuccess(await claimOk(ctx, kit, HOLDER, [nextTxHash()]));
        const fit = await claimOk(ctx, kit, HOLDER, [nextTxHash(), nextTxHash()]);
        assertSuccess(fit);
        assert.strictEqual(fit.emittedActions.filter(e => e.action === 'SEND').length, 1);
        assert.deepStrictEqual(kit.counts(), { creditKeys: '4', credit: '4', pendingCount: '0', pending: '0' });
        // One key past the ceiling: the smallest overshoot an off-by-one would admit.
        const over = await claimOk(ctx, kit, HOLDER, [nextTxHash()]);
        assertSuccess(over);
        assertEmittedActions(over, []);
        assert.strictEqual(JSON.parse(over.returnValue), 'key limit reached');
        assert.deepStrictEqual(kit.counts(), { creditKeys: '4', credit: '4', pendingCount: '0', pending: '0' });
        assertSuccess(await kit.request(HOLDER));
        assertReverted(await kit.request(ctx.OTHER), 'too many claim checks');
    });

    it('control: an unreachable credit ceiling under the same VM key cap reverts and leaves the claimant pending', async function () {
        await kit.deploy(withCeilings(CODE, 1000000, 1), 4 + 1);
        assertSuccess(await claimOk(ctx, kit, HOLDER, [nextTxHash()]));
        assertSuccess(await claimOk(ctx, kit, HOLDER, [nextTxHash(), nextTxHash()]));
        const over = await claimOk(ctx, kit, HOLDER, [nextTxHash(), nextTxHash()]);
        assert.strictEqual(over.success, false);
        assert(String(over.error).includes('max state keys'), 'got: ' + over.error);
        assert.strictEqual(kit.counts().pending, '1');
        assertReverted(await kit.request(HOLDER), 'already pending');
    });

    it('keeps the shipped ceilings and initialize keys under the VM default key cap', async function () {
        const VM_DIR = path.join(__dirname, '..', '..', '..', 'xchain-vm');
        const { resolveLimits } = require(path.join(VM_DIR, 'src', 'index', 'runtime', 'limits_defaults.js'));
        const initKeys = await kit.deploy(CODE);
        assert(initKeys + 9000 + 900 <= resolveLimits().maxStateKeys,
            initKeys + ' initialize keys plus both ceilings exceed the VM key cap');
        const info = JSON.parse(JSON.parse((await kit.h.execute({ contractAddress: ctx.ADDR, method: 'info',
            params: [], caller: HOLDER })).returnValue));
        assert.strictEqual(info.maxCreditKeys, '9000');
        assert.strictEqual(info.maxPending, '900');
    });
}

function registerPendingCeilingTests(ctx) {
    const { assert, HOLDER, OTHER, CODE, assertSuccess, assertReverted, nextTxHash } = ctx;
    const kit = makeKit(ctx);

    it('refuses a request past the pending ceiling and frees a slot on both settle paths', async function () {
        await kit.deploy(withCeilings(CODE, 9000, 2), 9000 + 2);
        const first = await kit.request(HOLDER);
        const second = await kit.request(OTHER);
        assertSuccess(first);
        assertSuccess(second);
        assertReverted(await kit.request(THIRD), 'too many claim checks');
        assertSuccess(await kit.expire(HOLDER, JSON.parse(first.returnValue)));
        assert.deepStrictEqual([kit.counts().pendingCount, kit.counts().pending], ['1', '1']);
        const third = await kit.request(THIRD);
        assertSuccess(third);
        assertReverted(await kit.request(HOLDER), 'too many claim checks');
        assertSuccess(await kit.settle(OTHER, JSON.parse(second.returnValue), [nextTxHash()]));
        assertSuccess(await kit.request(HOLDER));
        assert.deepStrictEqual(kit.counts(), { creditKeys: '2', credit: '2', pendingCount: '2', pending: '2' });
        assertSuccess(await kit.settle(THIRD, JSON.parse(third.returnValue), []));
        assert.deepStrictEqual([kit.counts().pendingCount, kit.counts().pending], ['1', '1']);
    });
}
