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
        // Register decimals so the ledger re-rounds emissions the way the real
        // indexer does at write time, and so getTokenInfo (which refundBoth's
        // grid-flooring reads) resolves. A tick a contract actually holds always
        // carries token info on a real node.
        h.ledger.setTokenDecimals(TICK, 8);
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

        it('half-ulp off-grid stake still voids: both refund legs land on the tick grid', async function () {
            // A stake exactly half a base unit off the tick grid used to wedge
            // the PUSH and VOID paths permanently. refundBoth() emitted the raw
            // 0.000000015 to the maker and the complementary 0.000000025 to the
            // taker; the ledger re-rounds both UP at write time (half-up), so the
            // pair moved one base unit more than custody held, the taker's SEND
            // threw, and every settle()/reclaim() retry reverted with it.
            // Flooring the maker leg puts both legs on-grid, so the re-round is
            // a numeric no-op and the sub-unit residue rides the taker leg.
            const ODD = '0.000000015';
            h = new E2EHarness(XChainVM);
            h.seedBalance(MAKER, 'XCHAIN', '1000000');
            h.seedBalance(MAKER, TICK, '1');
            h.seedBalance(TAKER, TICK, '1');
            h.ledger.setTokenDecimals(TICK, 8);
            await h.deploy({
                code: CODE, deployer: MAKER, contractAddress: ADDR,
                params: [MAKER, PAIR, STRIKE, 'OVER', TICK, ODD, String(T), '3']
            });
            assertSuccess(await depositAnd(MAKER, 'fund', '0.00000002'));
            assertSuccess(await depositAnd(TAKER, 'accept', '0.00000002'));
            publishRounds({ 2: { ts: T - 100, price: '65000' } }); // stuck before T

            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));

            // Legs sum to exactly what was held: 0.00000001 + 0.00000003.
            assertBalance(h.ledger, MAKER, TICK, '0.99999999');
            assertBalance(h.ledger, TAKER, TICK, '1.00000001');
            assertContractBalance(h.ledger, ADDR, TICK, '0');
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

        it('STALE ORACLE, pre-flag-day node: the loser voids a bet history already decided', async function () {
            // Documents the exposure the ORACLE_STALE_ROUND_VISIBILITY flag day
            // closes, and it is why an instance running against a node that has
            // not crossed its height still needs a deadline long enough to
            // outlast an oracle stall (see this template's README advisory).
            // Pre-flag-day the indexer DROPS a tip round older than
            // ORACLE_MAX_PRICE_AGE_SECONDS from the getPrice() view while
            // getPriceAtRound() keeps it, so getPrice() denies the existence of
            // the very round that decided the bet.
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
            // Round 2 decides against the OVER maker, but the tip is suppressed.
            publishRoundsWithTip({ 2: { ts: T + 10, price: '59000' } }, null);

            // The winner cannot settle: settle() needs the tip before it may
            // walk the very history that holds the answer.
            assertReverted(await settleBy(TAKER), 'no oracle data yet');
            // ...and the LOSER's void is the only executable transition.
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }));
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
            assertBalance(h.ledger, TAKER, TICK, '100');   // the winner got their stake back, not the pot
        });

        it('STALE ORACLE, at/after the flag day: the withheld tip blocks the void and settle() pays the winner', async function () {
            // Same stall, same decided bet, on a node at/after the activation
            // height: the stale tip is kept with its PRICE withheld, so the
            // round's identity and timestamp are readable while its stale value
            // is not. That is all the O(1) void guard needs.
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
            publishRoundsWithTip({ 2: { ts: T + 10, price: '59000' } },
                { price: null, roundNumber: 2, timestamp: T + 10, stale: true });

            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
                'settle() instead');
            // settle() reads the deciding PRICE from immutable history, which
            // the freshness filter never touched.
            assertSuccess(await settleBy(TAKER));
            assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
            assertContractState(h.ledger, ADDR, 'settledRound', '2');
            assertBalance(h.ledger, TAKER, TICK, '200');
        });

        it('a withheld tip BEFORE settleTime still voids: the liveness hatch survives the flag day', async function () {
            // The gate must not turn a genuine "the oracle never reached the
            // settle time" stall into a wedged bet: the guard compares the
            // withheld tip's TIMESTAMP, which is below settleTime here.
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            publishRoundsWithTip({ 2: { ts: T - 100, price: '65000' } },
                { price: null, roundNumber: 2, timestamp: T - 100, stale: true });

            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
        });

        it('a scan read without round metadata fails loud instead of being skipped as a gap', async function () {
            // Shape drift, not a gap: an accessor whose getPrice returns the
            // full object but whose getPriceAtRound hands back a bare price
            // string. normalize() gives that read timestamp NaN, `NaN >= T` is
            // false, and the pre-fix scan stepped over the DECIDING round
            // exactly like a skipped one - the cursor advanced past it and a
            // later round would have settled the bet. latestRound() refuses
            // that shape; the scan must refuse it identically.
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            // Round 2 is the deciding round (ts >= T) but arrives bare; the
            // latest-round signal stays a well-formed object so latestRound()
            // passes and the scan is actually entered.
            h.ledger.seedOracle(PAIR, { price: '61000', roundNumber: 2, timestamp: T + 10 }, 0, { 2: '61000' });

            assertReverted(await settleBy(STRANGER), 'lacks round metadata');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
            assertContractBalance(h.ledger, ADDR, TICK, '200');
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

        // Notation gate. `amount` is raw maker-supplied constructor text and
        // math.gt(amount,'0') accepts every spelling mathjs parses, while
        // refundBoth()'s floorToDecimals is string surgery that assumes fixed
        // notation. Two proven failures if these reach state:
        //   '1.5e-8'       the floor no-ops (fraction '5e-8' is 4 chars, under the
        //                  8-decimal grid), the off-grid stake is emitted raw, the
        //                  indexer re-rounds both legs UP past custody and the
        //                  PUSH/VOID refund wedges permanently with funds stranded.
        //   '1.23456789e2' the floor CORRUPTS, returning '1.23456789' for a value of
        //                  123.456789: the maker is refunded 1% of their stake and
        //                  the remainder silently rides the taker leg. success=true,
        //                  no revert. Theft, not a wedge.
        // Deploy-time rejection is the guard; the half-ulp test above covers the
        // other half (legitimate fixed notation that is merely off the tick grid).
        it('rejects every non-fixed-notation spelling of stake and strike', async function () {
            const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                         '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                         'Infinity', 'NaN', '1.2.3'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, v, String(T), '5'])).success, false,
                    `stake ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, v, 'OVER', TICK, STAKE, String(T), '5'])).success, false,
                    `strike ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('still accepts ordinary fixed-notation terms, trailing zeros included', async function () {
            for (const v of ['100', '0.5', '60000.00', '0.000000015', '999999999999']) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, v, String(T), '5'])).success, true,
                    `stake ${JSON.stringify(v)} must deploy`);
            }
        });

        // Integer-shape gate on settleTime and deadlineBlocks. Both are raw maker
        // text, and a radix-less parseInt MEASURES them as something else entirely:
        // '1e2' is 1, '0x10' is 16, '7abc' is 7, ' 7' is 7, '5.99' is 5. The old
        // `parseInt(x) > 0` check then passes on the mis-measured value, so a maker
        // asking for a 100-block void window via '1e2' silently got a 1-block one.
        // A settleTime spelled that way collapsed to a 1970 timestamp, which the
        // in-the-future check rejected with a message about the wrong problem.
        it('rejects integer params a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e2', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                         '+7', '', 'abc', '-', 'Infinity', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, v, '5'])).success, false,
                    `settleTime ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), v])).success, false,
                    `deadlineBlocks ${JSON.stringify(v)} must not deploy`);
            }
            // Exponential settle times are caught by the SHAPE check now, not by
            // the future check: '1.7e9' is a real 2023 timestamp spelled the way
            // parseInt reads as 1.
            assert.strictEqual(
                (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '1.7e9', '5'])).success, false);
        });

        it('rejects integer params outside their range and stores accepted ones verbatim', async function () {
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), '0'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), '1000001'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '253402300800', '5'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), '1000000'])).success, true);

            // '100' means 100 blocks in state, not the 1 a parseInt of '1e2' gave.
            await deployBet('OVER', 100);
            assertContractState(h.ledger, ADDR, 'window', '100');
            assertContractState(h.ledger, ADDR, 'settleTime', String(T));
        });
    });
});
