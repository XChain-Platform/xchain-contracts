// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// priceBetTimed.test.js: behavioral + adversarial tests for priceBetTimed.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL priceBetTimed.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/priceBetTimed/priceBetTimed.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registerHappyPathTests = require('./price_bet_timed_test/happy_path_tests');
const registerOracleWindowAndTimingAttackTests = require('./price_bet_timed_test/oracle_window_and_timing_attack_tests');
const registerCustodyTests = require('./price_bet_timed_test/custody_tests');
const registerNumericSeamTests = require('./price_bet_timed_test/numeric_seam_tests');
const registerDeployValidationTests = require('./price_bet_timed_test/deploy_validation_tests');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertBalance,
    assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertBalance, assertContractBalance,
       assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping priceBetTimed tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'priceBetTimed.js'), 'utf8');

const MAKER    = 'maker';
const TAKER    = 'taker';
const STRANGER = 'stranger';
const ADDR     = 'C:BTC:1';
const TICK     = 'TEST';
const PAIR     = 'BTC/USD';
const STRIKE   = '60000';
const STAKE    = '100';

// Mock chain clock: height 1 / ts 1700000000 at deploy, +600s per mined block.
const T0 = 1700000000;
const T  = T0 + 1500;   // settle time: "2.5 blocks" after deploy

(XChainVM ? describe : describe.skip)('Template: priceBetTimed', function () {
    this.timeout(0);
    async function deployBet(side, window) {
        setHarness(new E2EHarness(XChainVM));
        h.seedBalance(MAKER, 'XCHAIN', '1000000');
        h.seedBalance(MAKER, TICK, '100');
        h.seedBalance(TAKER, TICK, '100');
        // Register decimals so the ledger re-rounds emissions the way the real
        // indexer does at write time, and so getTokenInfo (which refundBoth's
        // grid-flooring reads) resolves. A tick a contract actually holds always
        // carries token info on a real node.
        h.ledger.setTokenDecimals(TICK, 8);
        await h.deploy({
            code: CODE, deployer: MAKER, contractAddress: ADDR,
            params: [MAKER, PAIR, STRIKE, side || 'OVER', TICK, STAKE, String(T), String(window || 5)]
        });
        seedTipRound();
    }

    // Publish one pre-settleTime round so accept() has a tip to anchor the cursor
    // on (it refuses the match without one). Round 1 keeps the historic cursor = 1
    // start; a later publishRounds() replaces this history wholesale.
    function seedTipRound() {
        const tip = { price: '59000', roundNumber: 1, timestamp: T0 };
        h.ledger.seedOracle(PAIR, tip, 0, { 1: tip });
    }

    async function depositAnd(who, method, amount) {
        h.deposit(who, ADDR, TICK, amount || STAKE);
        return h.execute({ contractAddress: ADDR, method: method, params: [], caller: who });
    }

    // Seed finalized rounds in the PRODUCTION accessor shape. `spec` maps
    // roundNumber -> { ts, price }; the highest round becomes getPrice()'s
    // "latest". Gaps in the numbering model skipped/disputed rounds.
    function publishRounds(spec) {
        const rounds = {};
        let top = null;
        for (const n of Object.keys(spec).map(Number).sort((a, b) => a - b)) {
            rounds[n] = { price: spec[n].price, roundNumber: n, timestamp: spec[n].ts };
            top = rounds[n];
        }
        h.ledger.seedOracle(PAIR, top, 0, rounds);
    }

    // Same history as publishRounds, but with what getPrice() reports about the
    // TIP round overridden. Two shapes model the two sides of the indexer's
    // stale-round visibility flag day, for a tip older than
    // ORACLE_MAX_PRICE_AGE_SECONDS:
    //   null                                  before it: the stale tip is
    //                                         dropped from the getPrice() view
    //                                         entirely, while getPriceAtRound()
    //                                         keeps the very same round;
    //   { price: null, roundNumber, timestamp,
    //     stale: true }                       at/after it: the tip is kept with
    //                                         its price withheld.
    function publishRoundsWithTip(spec, tip) {
        publishRounds(spec);
        h.ledger.oraclePrices[PAIR].current = tip;
    }

    async function settleBy(caller) {
        return h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: caller || STRANGER });
    }
    function returned(r) { return JSON.parse(r.returnValue); }

    let current;
    const h = new Proxy({}, {
        get: function (_, key) {
            const value = current[key];
            return typeof value === 'function' ? value.bind(current) : value;
        }
    });
    function setHarness(next) { current = next; }

    const context = {
        ADDR, MAKER, TAKER, STRANGER, TICK, PAIR, STRIKE, STAKE, T0, T, CODE, XChainVM, E2EHarness,
        assert, assertSuccess, assertReverted, assertBalance, assertContractBalance, assertContractState,
        h, setHarness, deployBet, seedTipRound, depositAnd, publishRounds, publishRoundsWithTip,
        settleBy, returned
    };

    registerHappyPathTests(context);
    registerOracleWindowAndTimingAttackTests(context);
    registerCustodyTests(context);
    registerNumericSeamTests(context);
    registerDeployValidationTests(context);
});
