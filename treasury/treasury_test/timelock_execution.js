'use strict';

function registerTimingTests(context) {
    const {
        assert, assertReverted, HOLDER, PAY, ADDR, POLL, TIMELOCK, WINDOW,
        call, passedPoll, proposeAndArm, proposalStatus, readyToExecute
    } = context;

    it('an armed proposal cannot execute before the timelock elapses', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        context.h.ledger.seedPollResult(POLL, passedPoll());
        context.h.ledger.blockHeight = 1 + TIMELOCK - 1;
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'timelock has not elapsed');
    });

    it('an armed proposal expires after the execution window', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        context.h.ledger.seedPollResult(POLL, passedPoll());
        context.h.ledger.blockHeight = 1 + TIMELOCK + WINDOW + 1;
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'execution window has passed');
        assert.strictEqual(await proposalStatus(), 'EXPIRED');
    });

    it('execution re-verifies the poll on-chain: no verifiable result, no payout', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        context.h.ledger.blockHeight = 1 + TIMELOCK;
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'poll result not verifiable');
    });

    it('execution re-verifies the winner: a rewritten poll result cannot pay out', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        context.h.ledger.seedPollResult(POLL, { ...passedPoll(), winning_option: 1 });
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'poll result not verifiable');
    });

    it('execution re-verifies the electorate: a rewritten poll tick cannot pay out', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        context.h.ledger.seedPollResult(POLL, { ...passedPoll(), tick: 'JUNK' });
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'poll electorate is not the governance token');
        assert.strictEqual(await proposalStatus(), 'ARMED');
    });
}

function registerPollResultTests(context) {
    const {
        assert, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
        HOLDER, PAYEE, PAY, ADDR, POLL,
        call, passedPoll, proposeAndArm, proposalStatus, readyToExecute
    } = context;

    it('an exact weight tie arms (lowest-index tie-break) but cannot pay out', async function () {
        await proposeAndArm();
        assert.strictEqual(await proposalStatus(), 'ARMED');
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        context.h.ledger.seedPollResult(POLL, { ...passedPoll(), options: [
            { index: 0, weight: '4000', voters: 12 }, { index: 1, weight: '4000', voters: 12 }] });
        const r = await call('executeProposal', ['1'], HOLDER);
        assertReverted(r, 'did not strictly outweigh every other option');
        assertBalance(context.h.ledger, PAYEE, PAY, '0');
        assert.strictEqual(await proposalStatus(), 'ARMED');
    });

    it('a tie on a later option also blocks the payout', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        context.h.ledger.seedPollResult(POLL, { ...passedPoll(), options: [
            { index: 0, weight: '4000', voters: 12 }, { index: 1, weight: '10', voters: 1 },
            { index: 2, weight: '4000', voters: 9 }] });
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'did not strictly outweigh every other option');
    });

    it('a strict win by the smallest margin still pays out', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        context.h.ledger.seedPollResult(POLL, { ...passedPoll(), options: [
            { index: 0, weight: '4000', voters: 12 }, { index: 1, weight: '3999.999999999999999999', voters: 11 }] });
        const r = await call('executeProposal', ['1'], HOLDER);
        assertSuccess(r);
        assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '400' } }]);
        assert.strictEqual(await proposalStatus(), 'EXECUTED');
    });

    it('a snapshot without the approval option row cannot pay out', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        context.h.ledger.seedPollResult(POLL, { ...passedPoll(), options: [] });
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'did not strictly outweigh every other option');
    });
}

function registerBalanceBoundaryTests(context) {
    const {
        assert, assertSuccess, assertReverted, E2EHarness, XChainVM,
        GUARDIAN, HOLDER, PAYEE, PAY, GOV, ADDR, POLL, TIMELOCK, WINDOW, CODE,
        deploy, propose, call, pollCallback, proposeAndArm, proposalStatus, readyToExecute
    } = context;

    it('an underfunded treasury reverts instead of part-paying', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '399');
        readyToExecute();
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'insufficient treasury balance');
    });

    // At 1,000,000 units the 1e-12 tolerance spans 100 base units, so one short must still revert.
    it('a treasury one base unit short of a large payout reverts and stays armed', async function () {
        await deploy();
        context.h.seedBalance(HOLDER, PAY, '2000000');
        assertSuccess(await call('propose', [PAYEE, PAY, '1000000', 'large grant'], HOLDER));
        assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertSuccess(await pollCallback('1'));
        context.h.deposit(HOLDER, ADDR, PAY, '999999.99999999');
        readyToExecute();
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'insufficient treasury balance');
        assert.strictEqual(await proposalStatus(), 'ARMED');
        context.h.deposit(HOLDER, ADDR, PAY, '0.00000001');
        assertSuccess(await call('executeProposal', ['1'], HOLDER));
    });

    it('a holder one base unit short of a large threshold cannot propose', async function () {
        context.h = new E2EHarness(XChainVM);
        for (const who of [GUARDIAN, HOLDER]) context.h.seedBalance(who, 'XCHAIN', '1000000');
        context.h.seedBalance(HOLDER, GOV, '999999.99999999');
        await context.h.deploy({ code: CODE, deployer: GUARDIAN, contractAddress: ADDR,
            params: [GUARDIAN, GOV, String(TIMELOCK), String(WINDOW), '1000000', 'guardian'] });
        assertReverted(await propose(), 'insufficient governance holdings to propose');
        context.h.seedBalance(HOLDER, GOV, '1000000');
        assertSuccess(await propose());
    });
}

function registerRepeatExecutionTest(context) {
    const { assertSuccess, assertReverted, HOLDER, PAY, ADDR, call, proposeAndArm, readyToExecute } = context;

    it('a proposal cannot be executed twice', async function () {
        await proposeAndArm();
        context.h.deposit(HOLDER, ADDR, PAY, '1000');
        readyToExecute();
        assertSuccess(await call('executeProposal', ['1'], HOLDER));
        assertReverted(await call('executeProposal', ['1'], HOLDER), 'proposal is not armed');
    });
}

module.exports = function registerTimelockExecutionTests(context) {
    describe('timelock and execution window', function () {
        registerTimingTests(context);
        registerPollResultTests(context);
        registerBalanceBoundaryTests(context);
        registerRepeatExecutionTest(context);
    });
};
