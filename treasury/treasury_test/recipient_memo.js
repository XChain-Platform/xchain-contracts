'use strict';

const BECH32_P2WPKH = 'bcrt1qe6l04hhwjg98fmggptdm0cemj6lm7hhwzahaul';
const BECH32_P2WSH  = 'bcrt1qg2zrk70aelwvua5v5e06lca4mqdmnta7gt3pymurghg8wsw8z69q3p3pcw';
const BECH32M_P2TR  = 'bcrt1pxqgcx65hqkd9c7y6wulyfv2wlwawqx62n3ufwxkjhjpas2jtqxmsglytaf';
const BASE58_P2SH   = '2NETsvK6gpTRsvxt3z4oJJLVof6BkA9AHmQ';

function proposeAs(context, recipient, memo) {
    const params = [recipient, context.PAY, '10'];
    if (memo !== undefined) params.push(memo);
    return context.call('propose', params, context.HOLDER);
}

// Propose with `memo`, arm and execute: returns the payout SENDs.
async function payOut(context, memo) {
    const { GUARDIAN, ATTACKER, PAY, ADDR, POLL, HOLDER, deploy, call, pollCallback, readyToExecute } = context;
    await deploy();
    context.assertSuccess(await proposeAs(context, BECH32_P2WPKH, memo));
    context.assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
    context.assertSuccess(await pollCallback('1'));
    context.h.deposit(HOLDER, ADDR, PAY, '1000');
    readyToExecute();
    const r = await call('executeProposal', ['1'], ATTACKER);
    context.assertSuccess(r);
    return r.emittedActions.filter(function (e) { return e.action === 'SEND'; });
}

function registerPayoutMemo(context) {
    const { assert } = context;

    describe('payout memo', function () {
        it('the approved memo is sent with the payout', async function () {
            const sends = await payOut(context, 'grants round 1');
            assert.strictEqual(sends.length, 1);
            assert.strictEqual(sends[0].params.memo, 'grants round 1');
            assert.strictEqual(sends[0].params.destination, BECH32_P2WPKH);
        });

        it('a proposal given no memo executes and its payout carries none', async function () {
            const sends = await payOut(context, undefined);
            assert.strictEqual(sends.length, 1);
            assert.ok(!sends[0].params.memo, 'no memo is invented for a memo-less proposal');
        });

        it('a proposal with an empty memo executes and its payout carries none', async function () {
            const sends = await payOut(context, '');
            assert.strictEqual(sends.length, 1);
            assert.ok(!sends[0].params.memo);
        });
    });
}

function registerRecipientGate(context) {
    const { assert, assertSuccess, assertReverted, HOLDER, deploy, call } = context;

    describe('recipient shape gate at propose()', function () {
        it('accepts base58 and bech32 recipients, either letter case', async function () {
            await deploy();
            for (const ok of [BASE58_P2SH, BECH32_P2WPKH, BECH32_P2WSH, BECH32M_P2TR,
                BECH32_P2WPKH.toUpperCase(), 'a'.repeat(14), 'a1'.repeat(45)])
                assertSuccess(await proposeAs(context, ok, 'm'), ok);
        });

        it('rejects strings no address can take and records nothing', async function () {
            await deploy();
            for (const bad of ['payee', 'a'.repeat(13), 'a'.repeat(91), 'C:BTC:1234567890123',
                '^12345678901234', 'bcrt1q e6l04hhwjg98fmggptdm', 'bcrt1qe6l04hhwjg98fmgg-ptdm0cemj6l'])
                assertReverted(await proposeAs(context, bad, 'm'), 'recipient must be a plain address');
            const info = JSON.parse(JSON.parse((await call('info', [], HOLDER)).returnValue));
            assert.strictEqual(info.proposals, '0');
        });
    });
}

function registerMemoGate(context) {
    const { assertSuccess, assertReverted, deploy } = context;

    describe('memo gate at propose()', function () {
        it('accepts a memo of exactly 250 characters and rejects 251', async function () {
            await deploy();
            assertSuccess(await proposeAs(context, BECH32_P2WPKH, 'm'.repeat(250)));
            assertReverted(await proposeAs(context, BECH32_P2WPKH, 'm'.repeat(251)), 'at most 250');
        });

        it('rejects a memo with a pipe or a semicolon', async function () {
            await deploy();
            assertReverted(await proposeAs(context, BECH32_P2WPKH, 'a|b'), 'cannot contain');
            assertReverted(await proposeAs(context, BECH32_P2WPKH, 'a;b'), 'cannot contain');
            assertSuccess(await proposeAs(context, BECH32_P2WPKH, 'a,b:c'));
        });
    });
}

module.exports = function registerRecipientMemoTests(context) {
    registerPayoutMemo(context);
    registerRecipientGate(context);
    registerMemoGate(context);
};
