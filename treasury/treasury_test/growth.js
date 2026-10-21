'use strict';

const assert = require('assert');
const { Harness, available } = require('../../test/helpers/harness.js');

const STATE_KEY_LIMIT = 10;
const SETTLED_PROPOSALS = 24;

function seed(h, context) {
    for (const who of [context.GUARDIAN, context.HOLDER, context.ATTACKER, context.PAYEE])
        h.seedBalance(who, 'XCHAIN', '1000000');
    h.seedBalance(context.HOLDER, context.GOV, '1000');
    h.seedBalance(context.ATTACKER, context.GOV, '1000');
}

function deployInProcess(context) {
    const h = new Harness({ limits: { maxStateKeys: STATE_KEY_LIMIT } });
    seed(h, context);
    const result = h.deploy({
        code: context.CODE,
        deployer: context.GUARDIAN,
        contractAddress: context.ADDR,
        params: [context.GUARDIAN, context.GOV, String(context.TIMELOCK),
            String(context.WINDOW), context.MIN_PROPOSE, 'guardian']
    });
    assert.ok(result.success, result.error);
    return h;
}

function inProcessCall(h, context, method, params, caller) {
    return h.execute({ contractAddress: context.ADDR, method, params, caller });
}

async function deployE2E(context, limits) {
    const options = limits ? { limits } : undefined;
    const h = new context.E2EHarness(context.XChainVM, options);
    seed(h, context);
    const result = await h.deploy({
        code: context.CODE,
        deployer: context.GUARDIAN,
        contractAddress: context.ADDR,
        params: [context.GUARDIAN, context.GOV, String(context.TIMELOCK),
            String(context.WINDOW), context.MIN_PROPOSE, 'guardian']
    });
    context.assertSuccess(result);
    return h;
}

function e2eCall(context, h, method, params, caller) {
    return h.execute({ contractAddress: context.ADDR, method, params, caller });
}

function registerInProcessGrowthTests(context) {
    (available ? describe : describe.skip)('bounded proposal state (in-process limits)', function () {
        it('reuses the key budget after more settled proposals than the key limit', function () {
            const h = deployInProcess(context);
            for (let i = 1; i <= SETTLED_PROPOSALS; i++) {
                const proposed = inProcessCall(h, context, 'propose',
                    [context.PAYEE, context.PAY, '1', 'settle ' + i], context.HOLDER);
                assert.ok(proposed.success, proposed.error);
                const cancelled = inProcessCall(h, context, 'cancel', [String(i)], context.HOLDER);
                assert.ok(cancelled.success, cancelled.error);
                assert.ok(Object.keys(h.ledger.state[context.ADDR]).length <= STATE_KEY_LIMIT);
            }
            const next = inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'still open'], context.ATTACKER);
            assert.ok(next.success, next.error);
            assert.strictEqual(next.result, String(SETTLED_PROPOSALS + 1));
        });

        it('reclaims an abandoned holder slot after the configured window', function () {
            const h = deployInProcess(context);
            assert.ok(inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'abandoned'], context.HOLDER).success);
            const blocked = inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'honest'], context.ATTACKER);
            assert.strictEqual(blocked.success, false);
            assert.match(blocked.error, /max state keys/);
            h.mineBlock(context.WINDOW + 1);
            const admitted = inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'honest'], context.ATTACKER);
            assert.ok(admitted.success, admitted.error);
        });

        it('caps one holder while leaving a live slot for another holder', function () {
            const h = new Harness({ limits: { maxStateKeys: 100 } });
            seed(h, context);
            assert.ok(h.deploy({ code: context.CODE, deployer: context.GUARDIAN,
                contractAddress: context.ADDR, params: [context.GUARDIAN, context.GOV,
                    String(context.TIMELOCK), String(context.WINDOW), context.MIN_PROPOSE,
                    'guardian'] }).success);
            for (let i = 0; i < 16; i++) assert.ok(inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'holder slot'], context.HOLDER).success);
            const capped = inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'one too many'], context.HOLDER);
            assert.strictEqual(capped.success, false);
            assert.match(capped.error, /proposer has reached the live proposal limit/);
            assert.ok(inProcessCall(h, context, 'propose',
                [context.PAYEE, context.PAY, '1', 'honest'], context.ATTACKER).success);
        });
    });
}

function registerE2EGrowthTests(context) {
    (context.XChainVM ? describe : describe.skip)('bounded proposal state (E2EHarness limits)', function () {
        it('reuses the real VM key budget after settled proposal growth', async function () {
            const h = await deployE2E(context, { maxStateKeys: STATE_KEY_LIMIT });
            for (let i = 1; i <= SETTLED_PROPOSALS; i++) {
                context.assertSuccess(await e2eCall(context, h, 'propose',
                    [context.PAYEE, context.PAY, '1', 'settle ' + i], context.HOLDER));
                context.assertSuccess(await e2eCall(context, h, 'cancel', [String(i)], context.HOLDER));
                assert.ok(Object.keys(h.ledger.getContractState(context.ADDR)).length <= STATE_KEY_LIMIT);
            }
            const next = await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'still open'], context.ATTACKER);
            context.assertSuccess(next);
            assert.strictEqual(JSON.parse(next.returnValue), String(SETTLED_PROPOSALS + 1));
        });

        it('admits an honest holder after an abandoned proposal reaches its bound', async function () {
            const h = await deployE2E(context, { maxStateKeys: STATE_KEY_LIMIT });
            context.assertSuccess(await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'abandoned'], context.HOLDER));
            const blocked = await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'honest'], context.ATTACKER);
            assert.strictEqual(blocked.success, false);
            assert.match(blocked.error, /max state keys/);
            h.ledger.blockHeight += context.WINDOW + 1;
            const admitted = await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'honest'], context.ATTACKER);
            context.assertSuccess(admitted);
        });

        it('caps one holder while admitting another holder in the real VM', async function () {
            const h = await deployE2E(context);
            for (let i = 0; i < 16; i++) context.assertSuccess(await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'holder slot'], context.HOLDER));
            context.assertReverted(await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'one too many'], context.HOLDER),
            'proposer has reached the live proposal limit');
            context.assertSuccess(await e2eCall(context, h, 'propose',
                [context.PAYEE, context.PAY, '1', 'honest'], context.ATTACKER));
        });
    });
}

module.exports = function registerGrowthTests(context) {
    registerInProcessGrowthTests(context);
    registerE2EGrowthTests(context);
};
