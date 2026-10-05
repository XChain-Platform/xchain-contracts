'use strict';

module.exports = function registerVetoCancelTests(context) {
    const {
        assert, assertSuccess, assertReverted,
        GUARDIAN, HOLDER, ATTACKER, PAY, ADDR,
        deploy, propose, call, proposeAndArm, proposalStatus, readyToExecute
    } = context;

    describe('veto and cancel', function () {
        it('the guardian can veto an armed proposal inside the timelock', async function () {
            await proposeAndArm();
            assertSuccess(await call('veto', ['1'], GUARDIAN));
            assert.strictEqual(await proposalStatus(), 'VETOED');
            context.h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'proposal is not armed');
        });

        it('nobody but the guardian can veto', async function () {
            await proposeAndArm();
            assertReverted(await call('veto', ['1'], ATTACKER), 'only the guardian');
            assertReverted(await call('veto', ['1'], HOLDER), 'only the guardian');
        });

        it('an executed proposal cannot be vetoed', async function () {
            await proposeAndArm();
            context.h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            assertSuccess(await call('executeProposal', ['1'], HOLDER));
            assertReverted(await call('veto', ['1'], GUARDIAN), 'not vetoable');
        });

        it('the proposer can cancel before arming, and only before', async function () {
            await deploy();
            assertSuccess(await propose());
            assertReverted(await call('cancel', ['1'], ATTACKER), 'only the proposer');
            assertSuccess(await call('cancel', ['1'], HOLDER));
            assert.strictEqual(await proposalStatus(), 'CANCELLED');
        });

        it('an armed proposal cannot be cancelled by the proposer', async function () {
            await proposeAndArm();
            assertReverted(await call('cancel', ['1'], HOLDER), 'only an un-armed proposal');
        });
    });
};
