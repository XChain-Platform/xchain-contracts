// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// priceBet.test.js: behavioral + adversarial tests for priceBet.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL priceBet.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/priceBet/priceBet.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
    assertBalance, assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions,
       assertBalance, assertContractBalance, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping priceBet tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'priceBet.js'), 'utf8');

const MAKER    = 'maker';
const TAKER    = 'taker';
const STRANGER = 'stranger';
const ADDR     = 'C:BTC:1';
const TICK     = 'TEST';
const PAIR     = 'BTC/USD';
const STRIKE   = '60000';
const STAKE    = '100';
const ROUND    = 7;

(XChainVM ? describe : describe.skip)('Template: priceBet', function () {
    this.timeout(0);
    let h;

    // Deploy a fresh bet: maker takes `side` on BTC/USD @ 60000, decided by
    // oracle round 7, 100 TEST per side, 5-block oracle-liveness window.
    async function deployBet(side, window) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(MAKER, 'XCHAIN', '1000000');
        h.seedBalance(MAKER, TICK, '100');
        h.seedBalance(TAKER, TICK, '100');
        await h.deploy({
            code: CODE, deployer: MAKER, contractAddress: ADDR,
            params: [MAKER, PAIR, STRIKE, side || 'OVER', TICK, STAKE, String(ROUND), String(window || 5)]
        });
    }

    // Mirrors BATCH(DEPOSIT, EXECUTE(method)) from `who`.
    async function depositAnd(who, method, amount) {
        h.deposit(who, ADDR, TICK, amount || STAKE);
        return h.execute({ contractAddress: ADDR, method: method, params: [], caller: who });
    }

    // Publish the settle round at `price` (current price is irrelevant to the
    // bet). Seeds the PRODUCTION accessor shape -- getPriceAtRound returns a
    // { price, roundNumber, timestamp } object, not a bare string (see the
    // indexer's getOracleDataForVM + xchain-vm/src/readonly-accessors.js).
    function publishRound(price) {
        const rounds = {};
        rounds[ROUND] = { price: price, roundNumber: ROUND, timestamp: 1750000000 };
        h.ledger.seedOracle(PAIR, price, 0, rounds);
    }

    describe('happy paths', function () {
        it('round above the strike: OVER maker takes the whole pot', async function () {
            await deployBet('OVER');
            assertSuccess(await depositAnd(MAKER, 'fund'));
            assertContractState(h.ledger, ADDR, 'status', 'OPEN');
            assertSuccess(await depositAnd(TAKER, 'accept'));
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');

            publishRound('61000');
            const r = await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER });
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: MAKER, tick: TICK, quantity: '200' } }]);
            assertBalance(h.ledger, MAKER, TICK, '200');
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
            assertContractState(h.ledger, ADDR, 'winner', MAKER);
        });

        it('round below the strike: OVER maker loses, taker takes the pot', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            publishRound('59000');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER }));
            assertBalance(h.ledger, TAKER, TICK, '200');
            assertContractState(h.ledger, ADDR, 'winner', TAKER);
        });

        it('UNDER maker wins when the round is below the strike', async function () {
            await deployBet('UNDER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            publishRound('59999.99');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER }));
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('round exactly at the strike: push, both stakes returned', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            publishRound(STRIKE);
            const r = await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER });
            assertSuccess(r);
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertContractState(h.ledger, ADDR, 'status', 'PUSH');
        });

        it('maker cancels an unmatched bet and recovers their stake', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            const r = await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER });
            assertSuccess(r);
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('oracle never publishes the round: either party voids after the deadline', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            // before the deadline: rejected
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }),
                'deadline not reached');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            const r = await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER });
            assertSuccess(r);
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
        });
    });

    describe('attacks we considered', function () {
        it('settle before the round is published reverts', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            // current price exists but round 7 does not: must NOT settle on it
            h.ledger.seedOracle(PAIR, '65000', 0, {});
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER }),
                'not published');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
        });

        it('reclaim() cannot dodge a lost bet once the round exists', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
            publishRound('59000'); // maker (OVER) lost
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
                'settle() instead');
            // the honest path still works
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: TAKER }));
            assertBalance(h.ledger, TAKER, TICK, '200');
        });

        it('underfunded fund() and accept() revert (no trust in caller-supplied amounts)', async function () {
            await deployBet('OVER');
            assertReverted(await depositAnd(MAKER, 'fund', '50'), 'insufficient deposit');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
            // top up maker properly, then a cheap taker
            assertSuccess(await depositAnd(MAKER, 'fund', '50')); // 50 + 50 = 100 held
            assertReverted(await depositAnd(TAKER, 'accept', '50'), 'insufficient deposit');
            assertContractState(h.ledger, ADDR, 'status', 'OPEN');
        });

        it('the maker cannot take their own bet', async function () {
            await deployBet('OVER');
            h.seedBalance(MAKER, TICK, '300');
            await depositAnd(MAKER, 'fund');
            assertReverted(await depositAnd(MAKER, 'accept'), 'cannot take their own bet');
        });

        it('double-settle is impossible: the status guard blocks any second payout', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRound('61000');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER }));
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER }),
                'already settled');
            assertContractBalance(h.ledger, ADDR, TICK, '0'); // no second payout
        });

        it('cancel is maker-only and impossible once matched', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: STRANGER }),
                'only the maker');
            await depositAnd(TAKER, 'accept');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }),
                'not open');
        });

        it('reclaim is party-only', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: STRANGER }),
                'not a party');
        });

        it('accept before fund reverts', async function () {
            await deployBet('OVER');
            assertReverted(await depositAnd(TAKER, 'accept'), 'not open');
        });
    });

    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(MAKER, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: MAKER, contractAddress: 'C:BTC:2', params: params });
        }

        it('rejects an invalid side', async function () {
            const r = await deployWith([MAKER, PAIR, STRIKE, 'ABOVE', TICK, STAKE, '7', '5']);
            assert.strictEqual(r.success, false, 'side=ABOVE should revert in initialize');
        });

        it('rejects a non-positive stake and a non-positive round', async function () {
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, '0', '7', '5'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '0', '5'])).success, false);
        });
    });
});
