'use strict';

module.exports = function registerDecimalGridTests(context) {
    const {
        assert, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
        GUARDIAN, HOLDER, PAYEE, PAY, ADDR, POLL,
        deploy, call, pollCallback, readyToExecute
    } = context;

    describe('decimal-grid flooring (finding 2699)', function () {
        async function armAmount(amount) {
            await deploy();
            assertSuccess(await call('propose', [PAYEE, PAY, amount, 'grid test'], HOLDER));
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assertSuccess(await pollCallback('1'));
        }

        it('an off-grid amount is floored, pays out, and records the paid figure', async function () {
            await armAmount('100.123456789');
            context.h.deposit(HOLDER, ADDR, PAY, '100.12345678');
            readyToExecute();
            const r = await call('executeProposal', ['1'], HOLDER);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '100.12345678' } }]);
            assertBalance(context.h.ledger, PAYEE, PAY, '100.12345678');
            const rec = JSON.parse(JSON.parse((await call('proposalInfo', ['1'], HOLDER)).returnValue));
            assert.strictEqual(rec.status, 'EXECUTED');
            assert.strictEqual(rec.amount, '100.123456789', 'voted figure preserved');
            assert.strictEqual(rec.paid, '100.12345678', 'paid figure is the on-grid amount');
        });

        it('an on-grid amount passes through unchanged', async function () {
            await armAmount('100.12345678');
            context.h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            const r = await call('executeProposal', ['1'], HOLDER);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '100.12345678' } }]);
        });

        it('an amount that floors to zero reverts instead of a no-op send', async function () {
            await deploy();
            context.h.ledger.setTokenDecimals(PAY, 0);
            assertSuccess(await call('propose', [PAYEE, PAY, '0.9', 'dust'], HOLDER));
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assertSuccess(await pollCallback('1'));
            context.h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'below one unit');
        });
    });
};
