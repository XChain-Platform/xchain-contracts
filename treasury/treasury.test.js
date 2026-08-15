// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// treasury.test.js: behavioral + adversarial tests for treasury.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Loads the ACTUAL treasury.js template and runs it through xchain-vm's E2E
// harness (isolated-vm / Node 22). Run from the xchain-vm package:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/treasury/treasury.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertBalance;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertBalance }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping treasury tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'treasury.js'), 'utf8');

const GUARDIAN = 'guardian';
const HOLDER   = 'holder';        // governance-token holder (proposer)
const PAYEE    = 'payee';
const ATTACKER = 'attacker';
const ADDR     = 'C:BTC:1';       // the treasury contract
const GOV      = 'GOV';           // governance token
const PAY      = 'PAY';           // treasury asset being spent

const TIMELOCK = 10, WINDOW = 20, MIN_PROPOSE = '100';
const POLL = '501';               // a poll's VOTE v0 action_index

// A finalized poll result as the indexer exposes it to xchain.getPollResult.
function passedPoll() {
    return { status: 'finalized', winning_option: 0, total_weight: '4000', total_voters: 12,
             decided_early: false, options: [{ index: 0, weight: '4000', voters: 12 }] };
}

(XChainVM ? describe : describe.skip)('Template: treasury', function () {
    this.timeout(0);
    let h;

    async function deploy(mode) {
        h = new E2EHarness(XChainVM);
        for (const who of [GUARDIAN, HOLDER, ATTACKER, PAYEE])
            h.seedBalance(who, 'XCHAIN', '1000000');
        h.seedBalance(HOLDER, GOV, '1000');
        h.seedBalance(HOLDER, PAY, '5000');
        // The real indexer always knows a held tick's decimals (VM_BALANCE_TOKENINFO
        // gate); executeProposal reads them to floor the payout onto the grid.
        h.ledger.setTokenDecimals(PAY, 8);
        await h.deploy({
            code: CODE, deployer: GUARDIAN, contractAddress: ADDR,
            params: [GUARDIAN, GOV, String(TIMELOCK), String(WINDOW), MIN_PROPOSE, mode || 'guardian']
        });
    }
    function call(method, params, caller) {
        return h.execute({ contractAddress: ADDR, method, params: params || [], caller });
    }
    function propose(who) {
        return call('propose', [PAYEE, PAY, '400', 'grants round 1'], who || HOLDER);
    }
    // Simulate the VOTE finalization callback: a system-injected EXECUTE whose
    // SOURCE is the callback contract itself (VOTE spec, Binding polls).
    function pollCallback(proposalId, overrides) {
        const o = overrides || {};
        return call('arm', [
            o.poll || POLL, o.status || 'finalized', o.winning != null ? o.winning : '0',
            o.weight || '4000', o.voters || '12', o.quorum || '1', o.minVoters || '1',
            proposalId
        ], o.caller || ADDR);
    }
    async function proposeAndArm(mode) {
        await deploy(mode);
        assertSuccess(await propose());
        if ((mode || 'guardian') === 'guardian')
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
        assertSuccess(await pollCallback('1'));
    }
    async function proposalStatus(id) {
        const r = await call('proposalInfo', [id || '1'], HOLDER);
        assertSuccess(r);
        return JSON.parse(JSON.parse(r.returnValue)).status;
    }
    // Jump past the timelock (arm happens at height 1) and make the poll
    // verifiable on-chain, the way a real chain would by the time the
    // timelock has elapsed.
    function readyToExecute() {
        h.ledger.blockHeight = 1 + TIMELOCK;
        h.ledger.seedPollResult(POLL, passedPoll());
    }

    describe('the happy path', function () {
        it('propose → approvePoll → arm → timelock → executeProposal pays out', async function () {
            await proposeAndArm();
            assert.strictEqual(await proposalStatus(), 'ARMED');

            h.deposit(HOLDER, ADDR, PAY, '1000');       // fund the treasury
            readyToExecute();
            const r = await call('executeProposal', ['1'], ATTACKER); // anyone may fire it
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '400' } }]);
            assertBalance(h.ledger, PAYEE, PAY, '400');
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

    describe('proposal gating', function () {
        it('an address without governance holdings cannot propose', async function () {
            await deploy();
            assertReverted(await propose(ATTACKER), 'insufficient governance holdings');
        });

        it('a zero amount cannot be proposed', async function () {
            await deploy();
            assertReverted(await call('propose', [PAYEE, PAY, '0', ''], HOLDER), 'amount must be positive');
        });
    });

    describe('arming (the BonkDAO surface)', function () {
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

        it('open mode: a passing poll arms without guardian approval', async function () {
            await proposeAndArm('open');
            assert.strictEqual(await proposalStatus(), 'ARMED');
        });

        it('open mode: approvePoll is not available', async function () {
            await deploy('open');
            assertSuccess(await propose());
            assertReverted(await call('approvePoll', ['1', POLL], GUARDIAN), 'only used in guardian mode');
        });
    });

    describe('timelock and execution window', function () {
        it('an armed proposal cannot execute before the timelock elapses', async function () {
            await proposeAndArm();
            h.deposit(HOLDER, ADDR, PAY, '1000');
            h.ledger.seedPollResult(POLL, passedPoll());
            h.ledger.blockHeight = 1 + TIMELOCK - 1;
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'timelock has not elapsed');
        });

        it('an armed proposal expires after the execution window', async function () {
            await proposeAndArm();
            h.deposit(HOLDER, ADDR, PAY, '1000');
            h.ledger.seedPollResult(POLL, passedPoll());
            h.ledger.blockHeight = 1 + TIMELOCK + WINDOW + 1;
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'execution window has passed');
            assert.strictEqual(await proposalStatus(), 'EXPIRED');
        });

        it('execution re-verifies the poll on-chain: no verifiable result, no payout', async function () {
            await proposeAndArm();
            h.deposit(HOLDER, ADDR, PAY, '1000');
            h.ledger.blockHeight = 1 + TIMELOCK;      // poll result NOT seeded
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'poll result not verifiable');
        });

        it('execution re-verifies the winner: a rewritten poll result cannot pay out', async function () {
            await proposeAndArm();
            h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            h.ledger.seedPollResult(POLL, { ...passedPoll(), winning_option: 1 });
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'poll result not verifiable');
        });

        it('an underfunded treasury reverts instead of part-paying', async function () {
            await proposeAndArm();
            h.deposit(HOLDER, ADDR, PAY, '399');
            readyToExecute();
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'insufficient treasury balance');
        });

        it('a proposal cannot be executed twice', async function () {
            await proposeAndArm();
            h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            assertSuccess(await call('executeProposal', ['1'], HOLDER));
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'proposal is not armed');
        });
    });

    describe('decimal-grid flooring (finding 2699)', function () {
        // Arm a proposal for an arbitrary amount (bypassing the fixed-'400' helper).
        async function armAmount(amount) {
            await deploy();
            assertSuccess(await call('propose', [PAYEE, PAY, amount, 'grid test'], HOLDER));
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assertSuccess(await pollCallback('1'));
        }

        it('an off-grid amount is floored, pays out, and records the paid figure', async function () {
            // 9 fraction digits on an 8dp tick: unfloored, the indexer would
            // HALF-UP round the send UP to 100.12345679 > custody and wedge
            // the proposal in ARMED for the whole window.
            await armAmount('100.123456789');
            h.deposit(HOLDER, ADDR, PAY, '100.12345678');   // exactly the floored figure
            readyToExecute();
            const r = await call('executeProposal', ['1'], HOLDER);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '100.12345678' } }]);
            assertBalance(h.ledger, PAYEE, PAY, '100.12345678');
            const rec = JSON.parse(JSON.parse((await call('proposalInfo', ['1'], HOLDER)).returnValue));
            assert.strictEqual(rec.status, 'EXECUTED');
            assert.strictEqual(rec.amount, '100.123456789', 'voted figure preserved');
            assert.strictEqual(rec.paid, '100.12345678', 'paid figure is the on-grid amount');
        });

        it('an on-grid amount passes through unchanged', async function () {
            await armAmount('100.12345678');
            h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            const r = await call('executeProposal', ['1'], HOLDER);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: PAYEE, tick: PAY, quantity: '100.12345678' } }]);
        });

        it('an amount that floors to zero reverts instead of a no-op send', async function () {
            // Re-register PAY at 0 decimals: a sub-unit proposal floors to '0'.
            await deploy();
            h.ledger.setTokenDecimals(PAY, 0);
            assertSuccess(await call('propose', [PAYEE, PAY, '0.9', 'dust'], HOLDER));
            assertSuccess(await call('approvePoll', ['1', POLL], GUARDIAN));
            assertSuccess(await pollCallback('1'));
            h.deposit(HOLDER, ADDR, PAY, '1000');
            readyToExecute();
            assertReverted(await call('executeProposal', ['1'], HOLDER), 'below one unit');
        });
    });

    describe('veto and cancel', function () {
        it('the guardian can veto an armed proposal inside the timelock', async function () {
            await proposeAndArm();
            assertSuccess(await call('veto', ['1'], GUARDIAN));
            assert.strictEqual(await proposalStatus(), 'VETOED');
            h.deposit(HOLDER, ADDR, PAY, '1000');
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
            h.deposit(HOLDER, ADDR, PAY, '1000');
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

    describe('deploy-time validation', function () {
        async function badDeploy(params) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(GUARDIAN, 'XCHAIN', '1000000');
            return b.deploy({ code: CODE, deployer: GUARDIAN, contractAddress: 'C:BTC:9', params });
        }
        it('rejects a zero timelock', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '0', '20', MIN_PROPOSE, 'guardian'])).success, false);
        });
        it('rejects an unknown mode', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '10', '20', MIN_PROPOSE, 'maybe'])).success, false);
        });
        it('rejects a zero proposal threshold', async function () {
            assert.strictEqual((await badDeploy([GUARDIAN, GOV, '10', '20', '0', 'guardian'])).success, false);
        });
        it('rejects a missing guardian', async function () {
            assert.strictEqual((await badDeploy(['', GOV, '10', '20', MIN_PROPOSE, 'guardian'])).success, false);
        });
    });

    describe('unknown proposals', function () {
        it('reads and writes against a nonexistent id revert', async function () {
            await deploy();
            assertReverted(await call('proposalInfo', ['7'], HOLDER), 'unknown proposal');
            assertReverted(await call('veto', ['7'], GUARDIAN), 'unknown proposal');
            assertReverted(await call('executeProposal', ['7'], HOLDER), 'unknown proposal');
        });
    });
});
