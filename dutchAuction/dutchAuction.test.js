// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// dutchAuction.test.js: behavioral + adversarial tests for dutchAuction.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL dutchAuction.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/dutchAuction/dutchAuction.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { registerAttackCases } = require('./dutch_auction_test/attack_cases');
const { registerDeployValidationCases } = require('./dutch_auction_test/deploy_validation_cases');
const { registerExactCustodyAndPaymentCases } = require('./dutch_auction_test/exact_custody_and_payment_cases');
const { registerHappyPathCases } = require('./dutch_auction_test/happy_path_cases');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
    assertBalance, assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions,
       assertBalance, assertContractBalance, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping dutchAuction tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'dutchAuction.js'), 'utf8');

const SELLER = 'seller';
const ITEM   = 'ITEM';
const BID    = 'TEST';
const ADDR   = 'C:BTC:1';

(XChainVM ? describe : describe.skip)('Template: dutchAuction', function () {
    this.timeout(0);
    const context = { h: null };

    // Deploy a fresh auction: 10 ITEM for sale, price 1000 -> 100 TEST over
    // `duration` blocks (0-decimal TEST so the linear price grid is exact).
    async function deployAuction(duration) {
        context.h = new E2EHarness(XChainVM);
        context.h.seedBalance(SELLER, 'XCHAIN', '1000000');
        context.h.seedBalance(SELLER, ITEM, '10');
        context.h.ledger.setTokenDecimals(BID, 0);
        // fund() reads itemTick's decimals to check the amount lands on its grid, and
        // the harness's decimals registry is balance-INDEPENDENT (MockLedger) while a
        // node's is not: the indexer builds balances and tokenInfo from ONE snapshot
        // over SOURCE + the contract address (src/db/index.js buildVmBalancesAndTokenInfo), so a
        // tick the contract holds a just-DEPOSITed amount of always carries its info
        // in the same snapshot getBalance reads. Seeding the item tick models that
        // reachability; it is not the stableVault trap of seeding a tick nobody holds.
        context.h.ledger.setTokenDecimals(ITEM, 0);
        await context.h.deploy({
            code: CODE, deployer: SELLER, contractAddress: ADDR,
            params: [SELLER, ITEM, '10', BID, '1000', '100', String(duration || 10)]
        });
    }

    // Same-batch fund: deposit the item then fund(). Mirrors BATCH(DEPOSIT, EXECUTE("fund")).
    async function depositAndFund() {
        context.h.deposit(SELLER, ADDR, ITEM, '10');
        return context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER });
    }

    // Same-batch buy: fund the buyer, deposit `pay` of BID, then buy(). Mirrors
    // BATCH(DEPOSIT, EXECUTE("buy")).
    async function buy(buyer, pay) {
        context.h.seedBalance(buyer, BID, pay);
        context.h.deposit(buyer, ADDR, BID, pay);
        return context.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: buyer });
    }

    Object.assign(context, {
        ADDR, BID, CODE, E2EHarness, ITEM, SELLER, XChainVM, assert,
        assertBalance, assertContractBalance, assertContractState,
        assertEmittedActions, assertReverted, assertSuccess,
        buy, deployAuction, depositAndFund
    });

    registerHappyPathCases(context);
    registerAttackCases(context);
    registerExactCustodyAndPaymentCases(context);
    registerDeployValidationCases(context);
});
