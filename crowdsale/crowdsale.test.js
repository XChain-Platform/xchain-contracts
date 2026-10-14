// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// crowdsale.test.js: behavioral + adversarial tests for crowdsale.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Loads the ACTUAL crowdsale.js and runs it through xchain-vm's E2E harness
// (isolated-vm / Node 22). Run from the xchain-vm package:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/crowdsale/crowdsale.test.js
//
// Note on assertions: the E2E MockIndexer applies SEND but treats ISSUE as a no-op.
// The local harness wrapper credits ISSUE mintSupply to contract custody, matching
// the production indexer, so sale-token delivery is checked end to end.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registerOffGridPaymentTests = require('./crowdsale_test/off_grid_payments');
const registerDustContributionSuite = require('./crowdsale_test/dust_contribution');
const registerSaleFlow = require('./crowdsale_test/sale_flow');
const registerCapTests = require('./crowdsale_test/caps');
const registerDeployValidation = require('./crowdsale_test/deploy_validation');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
    assertContractBalance;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertBalance, assertContractBalance }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping crowdsale tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

if (E2EHarness) {
    const BaseHarness = E2EHarness;
    E2EHarness = class extends BaseHarness {
        async deploy(opts) {
            const deployed = await super.deploy(opts);
            if (deployed.success && deployed.result) {
                const issue = deployed.result.emittedActions.find(e => e.action === 'ISSUE');
                if (issue && issue.params.mintSupply)
                    this.ledger.creditContractBalance(opts.contractAddress, issue.params.tick, issue.params.mintSupply);
            }
            return deployed;
        }
    };
}

const CODE = fs.readFileSync(path.join(__dirname, 'crowdsale.js'), 'utf8');

const OWNER = 'owner', B1 = 'buyer1', B2 = 'buyer2', STRANGER = 'stranger';
const ADDR = 'C:BTC:1', PAY = 'PAY', SALE = 'SALE';
const RATE = '10', SOFT = '100', HARD = '200', DURATION = 50;

// Per-test harness helpers; kit.h is the harness of the most recent deploy.
function makeKit() {
    const kit = { h: null };
    kit.deploy = async function (over) {
        over = over || {};
        const h = kit.h = new E2EHarness(XChainVM);
        for (const a of [OWNER, B1, B2]) { h.seedBalance(a, 'XCHAIN', '1000000'); h.seedBalance(a, PAY, '500'); }
        // A held tick always carries token info on a real node; buy() reads it for change.
        h.ledger.setTokenDecimals(PAY, 8);
        return h.deploy({
            code: CODE, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, PAY, SALE, over.rate || RATE, over.soft || SOFT, over.hard || HARD,
                     String(DURATION), over.decimals || '8']
        });
    };
    // Same-batch pay: DEPOSIT then buy(), mirroring BATCH(DEPOSIT, EXECUTE("buy")).
    kit.buy = function (who, amount) {
        kit.h.deposit(who, ADDR, PAY, amount);
        return kit.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: who });
    };
    kit.call = function (method, who) {
        return kit.h.execute({ contractAddress: ADDR, method, params: [], caller: who });
    };
    // init sets the deadline DURATION blocks past the height the sale was deployed at.
    kit.close = function () {
        kit.h.ledger.blockHeight = kit.h.ledger.getContract(ADDR).blockIndex + DURATION;
    };
    return kit;
}

const assertDeliveredActions = function (result, expected) {
    assertEmittedActions(result, expected.map(function (entry) {
        if (entry.action !== 'MINT') return entry;
        return { action: 'SEND', params: entry.params };
    }));
};

(XChainVM ? describe : describe.skip)('Template: crowdsale', function () {
    this.timeout(0);
    const kit = makeKit();
    const ctx = {
        OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, RATE, SOFT, HARD, DURATION, CODE, XChainVM,
        E2EHarness, assert, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
        assertContractBalance
    };
    const deliveredCtx = Object.assign({}, ctx, { assertEmittedActions: assertDeliveredActions });

    registerSaleFlow(ctx, kit);
    registerCapTests(ctx, kit);
    registerDeployValidation(ctx);
    registerOffGridPaymentTests(deliveredCtx);
    registerDustContributionSuite(deliveredCtx);
});
