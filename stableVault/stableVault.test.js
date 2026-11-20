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
const registerWithheldOraclePriceTests = require('./stable_vault_test/withheld_oracle_prices');
const registerMintLockTests = require('./stable_vault_test/mint_lock');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
const INDEXER_DIR = path.join(__dirname, '..', '..', 'xchain-indexer');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertBalance,
    assertContractBalance, assertContractState;
let mintValidation, issueSupplyRules;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertBalance, assertContractBalance,
       assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
    mintValidation = require(path.join(INDEXER_DIR, 'src', 'actions', 'mint', 'validate.js'));
    issueSupplyRules = require(path.join(INDEXER_DIR, 'src', 'actions', 'issue', 'supply_rules.js'));
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
const STABLE_MAX_SUPPLY = '1000000000';

function makeHelpers(getH) {
    function setPrice(price, age) {
        const h = getH();
        const snapshotAge = age || 0;
        h.ledger.seedOracle(PAIR,
            { price: String(price), roundNumber: 1, timestamp: h.ledger.blockTimestamp - snapshotAge },
            snapshotAge, {});
    }
    const call = (who, method, params) =>
        getH().execute({ contractAddress: ADDR, method, params, caller: who });

    async function depositColl(who, amount) {
        getH().deposit(who, ADDR, COLL, amount);
        return call(who, 'deposit', []);
    }
    async function borrow(who, amount) { return call(who, 'borrow', [amount]); }
    async function repay(who, amount) {
        getH().deposit(who, ADDR, STABLE, amount);
        return call(who, 'repay', []);
    }
    async function withdraw(who, amount) { return call(who, 'withdraw', [amount]); }
    async function liquidate(who, owner, stakedStable) {
        getH().deposit(who, ADDR, STABLE, stakedStable);
        return call(who, 'liquidate', [owner]);
    }
    return { setPrice, depositColl, borrow, repay, withdraw, liquidate };
}

function makeDeployVault(setH) {
    return async function deployVault(stableDecimals = '8') {
        const h = new E2EHarness(XChainVM);
        setH(h);
        h.seedBalance(ALICE, 'XCHAIN', '1000000');
        h.seedBalance(ALICE, COLL, '100');
        h.seedBalance(BOB, COLL, '100');
        // Register decimals so the ledger normalizes emissions the way the real
        // indexer does and getTokenInfo (used by liquidate's grid-flooring) works.
        h.ledger.setTokenDecimals(COLL, 8);
        h.ledger.setTokenDecimals(STABLE, Number(stableDecimals));
        const deployed = await h.deploy({
            code: CODE, deployer: ALICE, contractAddress: ADDR,
            params: [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE, stableDecimals]
        });
        h.ledger.creditContractBalance(ADDR, STABLE, STABLE_MAX_SUPPLY);
        return deployed;
    };
}

function registerDustPayoutTests(ctx) {
    const { deployVault, setPrice, depositColl, borrow, repay, liquidate } = ctx;
    const { assertSuccess, assertBalance, assertContractBalance, assertContractState } = ctx;

    function registerDebtAndGuardTests() {
        it('burns a debt remainder below the tolerant comparison floor', async function () {
            await deployVault('18');
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            assertSuccess(await borrow(ALICE, '1.000000000000000001'));
            assertSuccess(await repay(ALICE, '1'));
            ctx.h.seedBalance(ALICE, STABLE, '1');

            const result = await repay(ALICE, '1');
            assertSuccess(result);
            assert.deepStrictEqual(result.emittedActions.map(a => [a.action, a.params.quantity]), [
                ['SEND', '0.999999999999999999']
            ]);
            assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', null);
            assertContractBalance(ctx.h.ledger, ADDR, STABLE, STABLE_MAX_SUPPLY);
        });

        it('routes both excess payouts through the exact comparison', function () {
            const guards = CODE.match(/if \(exceedsExactly\(xchain, excess, '0'\)\)/g) || [];
            assert.strictEqual(guards.length, 2);
        });
    }

    function registerLiquidationRefundTest() {
        it('refunds a liquidation excess below the tolerant comparison floor', async function () {
            await deployVault('18');
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            assertSuccess(await borrow(ALICE, '1'));
            setPrice('0.1');
            ctx.h.seedBalance(LIQ, STABLE, '1.000000000000000001');

            const result = await liquidate(LIQ, ALICE, '1.000000000000000001');
            assertSuccess(result);
            assert.strictEqual(result.emittedActions[1].action, 'SEND');
            assert.strictEqual(result.emittedActions[1].params.quantity, '0.000000000000000001');
            assertBalance(ctx.h.ledger, LIQ, STABLE, '0.000000000000000001');
            assertContractBalance(ctx.h.ledger, ADDR, STABLE, STABLE_MAX_SUPPLY);
        });
    }

    describe('exact dust payouts', function () {
        registerDebtAndGuardTests();
        registerLiquidationRefundTest();
    });
}

(XChainVM ? describe : describe.skip)('Template: stableVault (mini-MakerDAO)', function () {
    this.timeout(0);
    let h;

    const ctx = {
        get h() { return h; },
        set h(v) { h = v; },
        assert, XChainVM, E2EHarness, CODE, ALICE, BOB, LIQ, ADDR, COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE,
        STABLE_MAX_SUPPLY, mintValidation, issueSupplyRules,
        assertSuccess, assertReverted, assertBalance, assertContractBalance, assertContractState,
        deployVault: makeDeployVault(v => { h = v; }),
        ...makeHelpers(() => h)
    };

    registerHappyPathTests(ctx);
    registerAttackTests(ctx);
    registerFixedNotationAmountTests(ctx);
    registerDeployValidationTests(ctx);
    registerEmptyTokenInfoTests(ctx);
    registerExactCustodyTests(ctx);
    registerWithheldOraclePriceTests(ctx);
    registerMintLockTests(ctx);

    registerDustPayoutTests(ctx);
});

// Seeded invariant suite on the in-process harness (runs without the VM sibling).
require('./stable_vault_test/invariants');
require('./stable_vault_test/vault_slots');
