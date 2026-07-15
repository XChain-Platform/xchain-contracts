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
    let h;

    async function deployBet(side, window) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(MAKER, 'XCHAIN', '1000000');
        h.seedBalance(MAKER, TICK, '100');
        h.seedBalance(TAKER, TICK, '100');
        await h.deploy({
            code: CODE, deployer: MAKER, contractAddress: ADDR,
            params: [MAKER, PAIR, STRIKE, side || 'OVER', TICK, STAKE, String(T), String(window || 5)]
        });
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

    async function settleBy(caller) {
        return h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: caller || STRANGER });
    }
    function returned(r) { return JSON.parse(r.returnValue); }

    describe('happy paths', function () {
        it('the FIRST round at/after settleTime decides: gaps skipped, later rounds ignored', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            // Rounds 3 and 5 are pre-deadline noise, 4 and 6 are gaps
            // (skipped/disputed), 7 is the first at/after T, 8 is later and
            // BELOW the strike - it must not matter.
            publishRounds({
                3: { ts: T - 900, price: '59000' },
                5: { ts: T - 300, price: '59500' },
                7: { ts: T + 100, price: '61000' },
                8: { ts: T + 700, price: '50000' }
            });

            const r = await settleBy(STRANGER);
            assertSuccess(r);
            assert.strictEqual(returned(r), 'SETTLED');
            assertBalance(h.ledger, MAKER, TICK, '200');       // OVER maker wins on round 7
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
            assertContractState(h.ledger, ADDR, 'settledRound', '7');
            assertContractState(h.ledger, ADDR, 'winner', MAKER);
        });

        it('UNDER maker wins when the deciding round is below the strike', async function () {
            await deployBet('UNDER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 50, price: '59999.99' } });
            assertSuccess(await settleBy(STRANGER));
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('deciding round exactly at the strike: push, both stakes returned', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 50, price: STRIKE } });
            const r = await settleBy(STRANGER);
            assertSuccess(r);
            assert.strictEqual(returned(r), 'PUSH');
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'PUSH');
        });

        it('no qualifying round yet: settle() is a valid no-op returning PENDING', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 3: { ts: T - 100, price: '65000' } }); // latest still before T
            const r = await settleBy(STRANGER);
            assertSuccess(r);
            assert.strictEqual(returned(r), 'PENDING');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED'); // untouched
            assertContractBalance(h.ledger, ADDR, TICK, '200');
        });

        it('long pre-deadline backlog is paged: SCANNING persists the cursor, next call settles', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept'); // no oracle data yet -> cursor = 1

            // 250 noise rounds before T, the qualifying one at 251. The scan
            // cap is 200 reads per call, so one settle() cannot reach it.
            const spec = {};
            for (let n = 1; n <= 250; n++) spec[n] = { ts: T - 1000 + n, price: '59000' };
            spec[251] = { ts: T + 60, price: '61000' };
            publishRounds(spec);

            const first = await settleBy(STRANGER);
            assertSuccess(first);
            assert.strictEqual(returned(first), 'SCANNING');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
            assertContractState(h.ledger, ADDR, 'cursor', '201'); // 1 + 200 reads

            const second = await settleBy(STRANGER);
            assertSuccess(second);
            assert.strictEqual(returned(second), 'SETTLED');
            assertContractState(h.ledger, ADDR, 'settledRound', '251');
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('maker cancels an unmatched bet and recovers their stake', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }));
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('oracle never reaches settleTime: either party voids after the deadline', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T - 100, price: '65000' } }); // stuck before T

            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }),
                'deadline not reached');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
        });
    });

    describe('attacks we considered', function () {
        it('accept after the settle time reverts (betting window closed)', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // ts 1700001800 >= T
            assertReverted(await depositAnd(TAKER, 'accept'), 'betting window closed');
        });

        it('reclaim() cannot dodge a lost bet once a qualifying round exists', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
            publishRounds({ 2: { ts: T + 10, price: '59000' } }); // maker (OVER) lost
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
                'settle() instead');
            assertSuccess(await settleBy(TAKER));
            assertBalance(h.ledger, TAKER, TICK, '200');
        });

        it('double-settle is impossible: the status guard blocks any second payout', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 10, price: '61000' } });
            assertSuccess(await settleBy(STRANGER));
            assertReverted(await settleBy(STRANGER), 'already settled');
            assertContractBalance(h.ledger, ADDR, TICK, '0');
        });

        it('underfunded accept reverts; the maker cannot take their own bet', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            assertReverted(await depositAnd(TAKER, 'accept', '50'), 'insufficient deposit');
            h.seedBalance(MAKER, TICK, '300');
            assertReverted(await depositAnd(MAKER, 'accept'), 'cannot take their own bet');
        });
    });

    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(MAKER, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: MAKER, contractAddress: 'C:BTC:2', params: params });
        }

        it('rejects a settle time in the past and an invalid side', async function () {
            const past = await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T0 - 100), '5']);
            assert.strictEqual(past.success, false, 'settleTime in the past should revert in initialize');
            const side = await deployWith([MAKER, PAIR, STRIKE, 'HIGHER', TICK, STAKE, String(T), '5']);
            assert.strictEqual(side.success, false, 'side=HIGHER should revert in initialize');
        });
    });
});
