'use strict';

module.exports = function registerHappyPathTests(context) {
    const {
        assert, assertSuccess, assertEmittedActions, assertBalance,
        HOLDER, PAYEE, ATTACKER, PAY, ADDR,
        deploy, propose, proposeAndArm, call, proposalStatus, readyToExecute
    } = context;

    describe('the happy path', function () {
        it('propose → approvePoll → arm → timelock → executeProposal pays out', async function () {
            await proposeAndArm();
            assert.strictEqual(await proposalStatus(), 'ARMED');

            context.h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            const r = await call('executeProposal', ['1'], ATTACKER);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '400' } }]);
            assertBalance(context.h.ledger, PAYEE, PAY, '400');
            assert.strictEqual(await proposalStatus(), 'EXECUTED');
        });

        it('proposals get sequential ids and readable records', async function () {
            await deploy();
            assertSuccess(await propose());
            const r2 = await propose();
            assertSuccess(r2);
            assert.strictEqual(JSON.parse(r2.returnValue), '2');
            const rec = JSON.parse(JSON.parse((await call('proposalInfo', ['2'], HOLDER)).returnValue));
            assert.strictEqual(rec.proposer, HOLDER);
            assert.strictEqual(rec.amount, '400');
            assert.strictEqual(rec.status, 'PROPOSED');
        });
    });
};
