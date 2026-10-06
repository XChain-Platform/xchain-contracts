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

const registerHappyPathTests = require('./treasury_test/happy_path');
const registerProposalGatingTests = require('./treasury_test/proposal_gating');
const registerArmingTests = require('./treasury_test/arming');
const registerTimelockExecutionTests = require('./treasury_test/timelock_execution');
const registerDecimalGridTests = require('./treasury_test/decimal_grid');
const registerVetoCancelTests = require('./treasury_test/veto_cancel');
const registerAmountValidationTests = require('./treasury_test/amount_validation');
const registerDeployValidationTests = require('./treasury_test/deploy_validation');
const registerProposalIdTests = require('./treasury_test/proposal_ids');
const registerPollIndexTests = require('./treasury_test/poll_index');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
    assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertBalance, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping treasury tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'treasury.js'), 'utf8');

const GUARDIAN = 'guardian';
const HOLDER   = 'holder';
const PAYEE    = 'payee';
const ATTACKER = 'attacker';
const ADDR     = 'C:BTC:1';
const GOV      = 'GOV';
const PAY      = 'PAY';

const TIMELOCK = 10, WINDOW = 20, MIN_PROPOSE = '100';
const POLL = '501';

function passedPoll() {
    return { status: 'finalized', winning_option: 0, total_weight: '4000', total_voters: 12,
             decided_early: false, tick: GOV, options: [{ index: 0, weight: '4000', voters: 12 }] };
}

(XChainVM ? describe : describe.skip)('Template: treasury', function () {
    this.timeout(0);

    const context = {
        h: null,
        assert,
        XChainVM,
        E2EHarness,
        assertSuccess,
        assertReverted,
        assertEmittedActions,
        assertBalance,
        assertContractState,
        CODE,
        GUARDIAN,
        HOLDER,
        PAYEE,
        ATTACKER,
        ADDR,
        GOV,
        PAY,
        TIMELOCK,
        WINDOW,
        MIN_PROPOSE,
        POLL,
        passedPoll
    };

    async function deploy(mode) {
        context.h = new E2EHarness(XChainVM);
        for (const who of [GUARDIAN, HOLDER, ATTACKER, PAYEE])
            context.h.seedBalance(who, 'XCHAIN', '1000000');
        context.h.seedBalance(HOLDER, GOV, '1000');
        context.h.seedBalance(HOLDER, PAY, '5000');
        context.h.ledger.setTokenDecimals(PAY, 8);
        await context.h.deploy({
            code: CODE, deployer: GUARDIAN, contractAddress: ADDR,
            params: [GUARDIAN, GOV, String(TIMELOCK), String(WINDOW), MIN_PROPOSE, mode || 'guardian']
        });
    }

    function call(method, params, caller) {
        return context.h.execute({ contractAddress: ADDR, method, params: params || [], caller });
    }

    function propose(who) {
        return call('propose', [PAYEE, PAY, '400', 'grants round 1'], who || HOLDER);
    }

    function pollCallback(proposalId, overrides) {
        const o = overrides || {};
        const args = [
            o.poll || POLL, o.status || 'finalized', o.winning != null ? o.winning : '0',
            o.weight || '4000', o.voters || '12', o.quorum || '1', o.minVoters || '1',
            o.tick != null ? o.tick : GOV,
            proposalId
        ];
        if (o.dropTick) args.splice(7, 1);
        if (o.extraParam != null) args.push(o.extraParam);
        return call('arm', args, o.caller || ADDR);
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

    function readyToExecute() {
        context.h.ledger.blockHeight = 1 + TIMELOCK;
        context.h.ledger.seedPollResult(POLL, passedPoll());
    }

    Object.assign(context, {
        deploy, call, propose, pollCallback, proposeAndArm, proposalStatus, readyToExecute
    });

    registerHappyPathTests(context);
    registerProposalGatingTests(context);
    registerArmingTests(context);
    registerTimelockExecutionTests(context);
    registerDecimalGridTests(context);
    registerVetoCancelTests(context);
    registerAmountValidationTests(context);
    registerDeployValidationTests(context);
    registerProposalIdTests(context);
    registerPollIndexTests(context);
});
