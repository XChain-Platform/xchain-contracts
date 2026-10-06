'use strict';

// arm() compares the bound poll with === against the indexer's canonical index, so
// approvePoll refuses any non-canonical spelling that could never arm.
module.exports = function registerPollIndexTests(context) {
    const {
        assert, assertSuccess, assertReverted, GUARDIAN, HOLDER, POLL,
        deploy, propose, call, pollCallback, proposalStatus
    } = context;

    const BAD = ['0501', '5.01e2', '501.0', '+501', ' 501', '501 ', '0x1f5', '501abc',
                 '-501', '0', '00', '', '1e3'];

    async function deployGuardian() {
        await deploy('guardian');
        assertSuccess(await propose());
    }

    async function expectedPoll() {
        const r = await call('proposalInfo', ['1'], HOLDER);
        assertSuccess(r);
        return JSON.parse(JSON.parse(r.returnValue)).expected_poll;
    }

    describe('non-canonical poll indexes are rejected at bind time', function () {
        it('every non-canonical spelling of poll 501 reverts and binds nothing', async function () {
            await deployGuardian();
            for (const bad of BAD) {
                assertReverted(await call('approvePoll', ['1', bad], GUARDIAN), 'canonical positive integer');
                assert.strictEqual(await expectedPoll(), null, 'bound by ' + JSON.stringify(bad));
            }
        });

        it('the canonical index binds, is stored verbatim and arms', async function () {
            await deployGuardian();
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assert.strictEqual(await expectedPoll(), POLL);
            assertSuccess(await pollCallback('1'));
            assert.strictEqual(await proposalStatus('1'), 'ARMED');
        });

        it('the guardian can still bind the canonical index after a rejected spelling', async function () {
            await deployGuardian();
            assertReverted(await call('approvePoll', ['1', '0501'], GUARDIAN), 'canonical positive integer');
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assertSuccess(await pollCallback('1'));
            assert.strictEqual(await proposalStatus('1'), 'ARMED');
        });
    });
};
