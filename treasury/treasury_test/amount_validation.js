'use strict';

module.exports = function registerAmountValidationTests(context) {
    const {
        assert, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
        assertContractState, GUARDIAN, HOLDER, PAYEE, PAY, ADDR, POLL,
        deploy, call, pollCallback, readyToExecute
    } = context;

    // Notation gate on propose()'s amount. Every other floorToDecimals caller in
    // this repo feeds it a value xchain.math computed (the VM always formats math
    // results in fixed notation); propose()'s `amount` is raw proposer text stored
    // verbatim and only met by the floor at execute time, after a poll has
    // approved it. math.gt(amount, '0') accepts every spelling mathjs parses, and
    // the floor is string surgery that assumes fixed notation: fed '1.23456789e2'
    // it returns '1.23456789' for a value of 123.456789, so the treasury pays 1%
    // of a governance-approved transfer and rec.paid records the underpayment,
    // leaving the audit trail agreeing with the wrong number. No revert.
    describe('non-fixed-notation proposal amounts are rejected at propose()', function () {
        const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                     '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                     'Infinity', 'NaN', '1.2.3'];

        it('rejects every non-fixed-notation spelling, and records no proposal', async function () {
            await deploy();
            for (const v of BAD) {
                const r = await call('propose', [PAYEE, PAY, v, 'memo'], HOLDER);
                assert.strictEqual(r.success, false, `propose(${JSON.stringify(v)}) must not succeed`);
            }
            assertContractState(context.h.ledger, ADDR, 'proposal_count', '0');
            assertReverted(await call('propose', [PAYEE, PAY, '1.23456789e2', 'memo'], HOLDER),
                'plain decimal');
        });

        // The gate is notation only: an off-grid but legitimately-spelled amount
        // must still propose, arm, and pay out its FLOORED value, or the fix would
        // have swapped a silent underpayment for a lockout.
        it('still accepts ordinary fixed notation, off-grid values included', async function () {
            await deploy();
            assertSuccess(await call('propose', [PAYEE, PAY, '400.123456789', 'memo'], HOLDER));
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assertSuccess(await pollCallback('1'));
            context.h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            const r = await call('executeProposal', ['1'], HOLDER);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '400.12345678' } }]);
            assertBalance(context.h.ledger, PAYEE, PAY, '400.12345678');
        });
    });
};
