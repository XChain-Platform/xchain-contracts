'use strict';

function registerGuardianBindingTests(context) {
    const {
        assertSuccess, assertReverted, GUARDIAN, HOLDER, ATTACKER, POLL,
        deploy, propose, call, pollCallback
    } = context;

    it('a user calling arm directly is rejected: only the poll callback identity may arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { caller: ATTACKER }), 'only callable by a poll finalization callback');
        assertReverted(await pollCallback('1', { caller: GUARDIAN }), 'only callable by a poll finalization callback');
    });

    it('guardian mode: an unbound poll cannot arm, even if it passed', async function () {
        await deploy();
        assertSuccess(await propose());
        assertReverted(await pollCallback('1'), 'not the guardian-approved poll');
    });

    it('guardian mode: a different poll than the bound one cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { poll: '666' }), 'not the guardian-approved poll');
    });

    it('only the guardian can bind a poll', async function () {
        await deploy();
        assertSuccess(await propose());
        assertReverted(await call('approvePoll', ['1', POLL], ATTACKER), 'only the guardian');
        assertReverted(await call('approvePoll', ['1', POLL], HOLDER), 'only the guardian');
    });
}

function registerPollOutcomeTests(context) {
    const {
        assertSuccess, assertReverted, GUARDIAN, POLL,
        deploy, propose, call, pollCallback, proposeAndArm
    } = context;

    it('a failed-quorum finalization cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { status: 'failed_quorum', quorum: '0' }), 'did not finalize');
    });

    it('a poll won by the reject option cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { winning: '1' }), 'not the approval option');
    });

    it('unmet gates cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { minVoters: '0' }), 'poll gates not met');
    });

    it('a proposal cannot be armed twice', async function () {
        await proposeAndArm();
        assertReverted(await pollCallback('1'), 'not awaiting a poll');
    });
}

function registerCallbackLayoutTests(context) {
    const {
        assert, assertSuccess, assertReverted, GUARDIAN, POLL,
        deploy, propose, call, pollCallback, proposalStatus
    } = context;

    // The callback signature moved when VOTE_POLL_TICK_VISIBLE activated: the
    // electorate tick was inserted ahead of CALLBACK_PARAMS, pushing the bound
    // proposal id from slot 7 to slot 8. A contract that keeps reading slot 7
    // gets the ticker string, loadProposal throws inside math.gt, the injected
    // EXECUTE rolls back to its savepoint, and the proposal is stuck PROPOSED
    // with the treasury's custody unspendable. These pin the live layout.
    it('a callback with the pre-flag-day 8-argument layout cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { dropTick: true }), 'unexpected callback signature');
        assert.strictEqual(await proposalStatus(), 'PROPOSED');
    });

    it('a callback carrying a spare CALLBACK_PARAM cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { extraParam: 'x' }), 'unexpected callback signature');
    });

    it('the proposal id is read from the slot after the tick, not the tick slot', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['2', POLL], GUARDIAN));
        assertSuccess(await pollCallback('2'));
        assert.strictEqual(await proposalStatus('2'), 'ARMED');
        assert.strictEqual(await proposalStatus('1'), 'PROPOSED');
    });
}

function registerElectorateTests(context) {
    const {
        assert, assertSuccess, assertReverted, GUARDIAN, POLL,
        deploy, propose, call, pollCallback, proposeAndArm, proposalStatus
    } = context;

    // The electorate pin: the protocol now says WHICH token voted, so a poll
    // over a token the attacker minted and controls is inert in open mode too,
    // not just behind the guardian's binding step.
    it('open mode: a poll over a look-alike token cannot arm', async function () {
        await deploy('open');
        assertSuccess(await propose());
        assertReverted(await pollCallback('1', { tick: 'JUNK' }), 'poll electorate is not the governance token');
        assert.strictEqual(await proposalStatus(), 'PROPOSED');
    });

    it('guardian mode: a bound poll over the wrong token still cannot arm', async function () {
        await deploy();
        assertSuccess(await propose());
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertReverted(await pollCallback('1', { tick: 'JUNK' }), 'poll electorate is not the governance token');
    });

    it('a poll bound to no token at all cannot arm', async function () {
        await deploy('open');
        assertSuccess(await propose());
        assertReverted(await pollCallback('1', { tick: '' }), 'poll electorate is not the governance token');
    });

    it('open mode: a passing poll arms without guardian approval', async function () {
        await proposeAndArm('open');
        assert.strictEqual(await proposalStatus(), 'ARMED');
    });

    it('open mode: approvePoll is not available', async function () {
        await deploy('open');
        assertSuccess(await propose());
        assertReverted(await call('approvePoll', ['1', POLL], GUARDIAN), 'only used in guardian mode');
    });
}

module.exports = function registerArmingTests(context) {
    describe('arming (the BonkDAO surface)', function () {
        registerGuardianBindingTests(context);
        registerPollOutcomeTests(context);
        registerCallbackLayoutTests(context);
        registerElectorateTests(context);
    });
};
