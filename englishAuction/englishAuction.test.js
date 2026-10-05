// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// englishAuction.test.js: behavioral + adversarial tests for englishAuction.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL englishAuction.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/englishAuction/englishAuction.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const registerHappyPathTests = require('./english_auction_test/happy_path_tests');
const registerAttackTests = require('./english_auction_test/attack_tests');
const registerExactCustodyTests = require('./english_auction_test/exact_custody_tests');
const registerDeployValidationTests = require('./english_auction_test/deploy_validation_tests');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
    assertBalance, assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions,
       assertBalance, assertContractBalance, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping englishAuction tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'englishAuction.js'), 'utf8');

const SELLER = 'seller';
const ITEM   = 'ITEM';
const BID    = 'TEST';
const ADDR   = 'C:BTC:1';

(XChainVM ? describe : describe.skip)('Template: englishAuction', function () {
    this.timeout(0);
    const env = { h: null };

    // Deploy a fresh auction: 10 ITEM for sale, min bid 50 TEST, `window` blocks.
    async function deployAuction(window) {
        env.h = new E2EHarness(XChainVM);
        env.h.seedBalance(SELLER, 'XCHAIN', '1000000');
        env.h.seedBalance(SELLER, ITEM, '10');
        // fund() reads itemTick's decimals to check the amount lands on its grid, and
        // the harness's decimals registry is balance-INDEPENDENT (MockLedger) while a
        // node's is not: the indexer builds balances and tokenInfo from ONE snapshot
        // over SOURCE + the contract address (src/db/index.js buildVmBalancesAndTokenInfo), so a
        // tick the contract holds a just-DEPOSITed amount of always carries its info
        // in the same snapshot getBalance reads. Seeding the item tick models that
        // reachability; it is not the stableVault trap of seeding a tick nobody holds.
        env.h.ledger.setTokenDecimals(ITEM, 0);
        await env.h.deploy({
            code: CODE, deployer: SELLER, contractAddress: ADDR,
            params: [SELLER, ITEM, '10', BID, '50', String(window || 5)]
        });
    }

    // Same-batch fund: deposit the item then fund(). Mirrors BATCH(DEPOSIT, EXECUTE("fund")).
    async function depositAndFund(amount) {
        env.h.deposit(SELLER, ADDR, ITEM, amount || '10');
        return env.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER });
    }

    // Same-batch bid: fund the bidder, deposit, then bid(). Mirrors
    // BATCH(DEPOSIT, EXECUTE("bid")).
    async function bid(bidder, amount) {
        env.h.seedBalance(bidder, BID, amount);
        env.h.deposit(bidder, ADDR, BID, amount);
        return env.h.execute({ contractAddress: ADDR, method: 'bid', params: [], caller: bidder });
    }

    const tests = {
        assert, XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
        assertBalance, assertContractBalance, assertContractState,
        CODE, SELLER, ITEM, BID, ADDR, env, deployAuction, depositAndFund, bid
    };
    registerHappyPathTests(tests);
    registerAttackTests(tests);
    registerExactCustodyTests(tests);
    registerDeployValidationTests(tests);
});
