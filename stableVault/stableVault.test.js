// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// stableVault.test.js: behavioral + adversarial tests for stableVault.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL stableVault.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/stableVault/stableVault.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registerHappyPathTests = require('./stable_vault_test/happy_paths');
const registerAttackTests = require('./stable_vault_test/attacks');
const registerFixedNotationAmountTests = require('./stable_vault_test/fixed_notation_amounts');
const registerDeployValidationTests = require('./stable_vault_test/deploy_validation');
const registerEmptyTokenInfoTests = require('./stable_vault_test/empty_token_info');
const registerExactCustodyTests = require('./stable_vault_test/exact_custody');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertBalance,
    assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertBalance, assertContractBalance,
       assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping stableVault tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'stableVault.js'), 'utf8');

const ALICE  = 'alice';
const BOB    = 'bob';
const LIQ    = 'liquidator';
const ADDR   = 'C:BTC:1';
const COLL   = 'GOLD';      // collateral token
const STABLE = 'DUSD';      // the stable this contract mints
const PAIR   = 'GOLD/USD';
const RATIO  = '150';       // 150% minimum collateralization
const BONUS  = '10';        // 10% liquidation bonus
const MAXAGE = '10';        // oracle freshness window, seconds

(XChainVM ? describe : describe.skip)('Template: stableVault (mini-MakerDAO)', function () {
    this.timeout(0);
    let h;

    async function deployVault() {
        h = new E2EHarness(XChainVM);
        h.seedBalance(ALICE, 'XCHAIN', '1000000');
        h.seedBalance(ALICE, COLL, '100');
        h.seedBalance(BOB, COLL, '100');
        // Register decimals so the ledger normalizes emissions the way the real
        // indexer does and getTokenInfo (used by liquidate's grid-flooring) works.
        h.ledger.setTokenDecimals(COLL, 8);
        h.ledger.setTokenDecimals(STABLE, 8);
        await h.deploy({
            code: CODE, deployer: ALICE, contractAddress: ADDR,
            params: [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE]
        });
    }

    // Latest finalized round in the production accessor shape, dated `age` seconds
    // before the current block so its timestamp agrees with the snapshot age.
    function setPrice(price, age) {
        const snapshotAge = age || 0;
        h.ledger.seedOracle(PAIR,
            { price: String(price), roundNumber: 1, timestamp: h.ledger.blockTimestamp - snapshotAge },
            snapshotAge, {});
    }

    async function depositColl(who, amount) {
        h.deposit(who, ADDR, COLL, amount);
        return h.execute({ contractAddress: ADDR, method: 'deposit', params: [], caller: who });
    }
    async function borrow(who, amount) {
        return h.execute({ contractAddress: ADDR, method: 'borrow', params: [amount], caller: who });
    }
    async function repay(who, amount) {
        h.deposit(who, ADDR, STABLE, amount);
        return h.execute({ contractAddress: ADDR, method: 'repay', params: [], caller: who });
    }
    async function withdraw(who, amount) {
        return h.execute({ contractAddress: ADDR, method: 'withdraw', params: [amount], caller: who });
    }
    async function liquidate(who, owner, stakedStable) {
        h.deposit(who, ADDR, STABLE, stakedStable);
        return h.execute({ contractAddress: ADDR, method: 'liquidate', params: [owner], caller: who });
    }

    const ctx = {
        get h() { return h; },
        set h(v) { h = v; },
        assert, XChainVM, E2EHarness, CODE, ALICE, BOB, LIQ, ADDR, COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE,
        assertSuccess, assertReverted, assertBalance, assertContractBalance, assertContractState,
        deployVault, setPrice, depositColl, borrow, repay, withdraw, liquidate
    };

    registerHappyPathTests(ctx);
    registerAttackTests(ctx);
    registerFixedNotationAmountTests(ctx);
    registerDeployValidationTests(ctx);
    registerEmptyTokenInfoTests(ctx);
    registerExactCustodyTests(ctx);
});
