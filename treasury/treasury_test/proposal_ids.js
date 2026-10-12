'use strict';

function registerUnknownProposalTests(context) {
    const { assertReverted, GUARDIAN, HOLDER, deploy, call } = context;

    describe('unknown proposals', function () {
        it('reads and writes against a nonexistent id revert', async function () {
            await deploy();
            assertReverted(await call('proposalInfo', ['7'], HOLDER), 'unknown proposal');
            assertReverted(await call('veto', ['7'], GUARDIAN), 'unknown proposal');
            assertReverted(await call('executeProposal', ['7'], HOLDER), 'unknown proposal');
        });
    });
}

function registerNonCanonicalProposalIdTests(context) {
    const {
        assert, assertSuccess, assertReverted, GUARDIAN, HOLDER, POLL,
        deploy, propose, call, pollCallback, proposalStatus
    } = context;

    // A mathjs range check read '1e1' as 10 while the parseInt storage key read it
    // as 1, so a non-canonical id bound, armed, vetoed or cancelled another proposal.
    describe('non-canonical proposal ids are rejected', function () {
        async function deployWith(mode, count) {
            await deploy(mode);
            for (let i = 0; i < count; i++) assertSuccess(await propose());
        }

        async function expectedPoll(id) {
            const r = await call('proposalInfo', [id], HOLDER);
            assertSuccess(r);
            return JSON.parse(JSON.parse(r.returnValue)).expected_poll;
        }

        it('guardian mode: approvePoll("1e1") binds nothing with ten proposals', async function () {
            await deployWith('guardian', 10);
            assertReverted(await call('approvePoll', ['1e1', POLL], GUARDIAN), 'unknown proposal');
            assert.strictEqual(await expectedPoll('1'), null);
            assert.strictEqual(await expectedPoll('10'), null);
        });

        it('open mode: a poll naming "1e1" arms nothing with ten proposals', async function () {
            await deployWith('open', 10);
            assertReverted(await pollCallback('1e1'), 'unknown proposal');
            assert.strictEqual(await proposalStatus('1'), 'PROPOSED');
            assert.strictEqual(await proposalStatus('10'), 'PROPOSED');
        });

        it('every other non-canonical spelling of id 1 reverts on read, veto and cancel', async function () {
            await deployWith('guardian', 2);
            for (const bad of ['1.9', '01', '+1', '-1', ' 1', '1 ', '0x1', '1.0', '1abc', '0', '3']) {
                assertReverted(await call('proposalInfo', [bad], HOLDER), 'unknown proposal');
                assertReverted(await call('veto', [bad], GUARDIAN), 'unknown proposal');
                assertReverted(await call('cancel', [bad], HOLDER), 'unknown proposal');
            }
            assert.strictEqual(await proposalStatus('1'), 'PROPOSED');
            assert.strictEqual(await proposalStatus('2'), 'PROPOSED');
        });

        it('the canonical id still binds and arms exactly its own proposal', async function () {
            await deployWith('guardian', 10);
            assertSuccess(await call('approvePoll', ['10', POLL], GUARDIAN));
            assertSuccess(await pollCallback('10'));
            assert.strictEqual(await proposalStatus('10'), 'ARMED');
            assert.strictEqual(await proposalStatus('1'), 'PROPOSED');
        });
    });
}

module.exports = function registerProposalIdTests(context) {
    registerUnknownProposalTests(context);
    registerNonCanonicalProposalIdTests(context);
};
