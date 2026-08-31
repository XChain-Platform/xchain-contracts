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
        // Register decimals so the ledger re-rounds emissions the way the real
        // indexer does at write time, and so getTokenInfo (which refundBoth's
        // grid-flooring reads) resolves. A tick a contract actually holds always
        // carries token info on a real node.
        h.ledger.setTokenDecimals(TICK, 8);
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

        it('half-ulp off-grid stake still pushes: both refund legs land on the tick grid', async function () {
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
                params: [MAKER, PAIR, STRIKE, 'OVER', TICK, ODD, String(ROUND), '5']
            });
            assertSuccess(await depositAnd(MAKER, 'fund', '0.00000002'));
            assertSuccess(await depositAnd(TAKER, 'accept', '0.00000002'));

            publishRound(STRIKE);
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: STRANGER }));

            // Legs sum to exactly what was held: 0.00000001 + 0.00000003.
            assertBalance(h.ledger, MAKER, TICK, '0.99999999');
            assertBalance(h.ledger, TAKER, TICK, '1.00000001');
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

        it('an OPEN bet cannot be sniped once the settle round is published', async function () {
            // The mirror image of the reclaim case above: settlement is a pure
            // function of consensus history, so the moment the settle round
            // finalizes the outcome is PUBLIC. Without the accept() guard a
            // taker reads the round, matches the winning side of a still-OPEN
            // bet and settles in the same breath - the maker's stake is free
            // money. accept() must close the window, and the maker's cancel()
            // escape must survive it.
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            assertContractState(h.ledger, ADDR, 'status', 'OPEN');

            publishRound('59000'); // below the strike: the OVER maker has lost
            assertReverted(await depositAnd(TAKER, 'accept'), 'settle round already published');
            assertContractState(h.ledger, ADDR, 'status', 'OPEN');

            // The maker is not stranded: cancel() is OPEN-only and still open.
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }));
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });

        // A node preloads a BOUNDED window of oracle history for the VM, so an old
        // enough round is unreadable from inside a contract. Without the window
        // floor it is indistinguishable from a round that never existed, which
        // turns this contract's void hatch into a refund button for whoever is
        // losing: refuse to settle, wait for the settle round to scroll out of the
        // window, reclaim.
        it('the loser cannot reclaim a decided bet by waiting for the round to scroll out', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock();       // past the deadline

            // The oracle published round 7 and the OVER maker lost... and then the
            // node's preload window moved past round 7 and dropped it.
            publishRound('59000');
            h.ledger.seedOracle(PAIR, '65000', 0, {});         // the round is gone from the payload
            h.ledger.seedOracleRoundFloor(ROUND + 1);          // and known to be gone, not absent

            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
                'outside the retrievable oracle window');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
            assertContractBalance(h.ledger, ADDR, TICK, '200');
            assertBalance(h.ledger, MAKER, TICK, '0');
        });

        it('an unpublished round INSIDE the window still voids, so the hatch still works', async function () {
            // The other side of the same guard: within the preloaded window an absent
            // round really is an absent round, and the liveness hatch must still open.
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            h.ledger.seedOracleRoundFloor(ROUND);              // round 7 is the oldest covered

            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
        });

        it('a bet on an already-evicted round is refused at deploy', async function () {
            // Such a bet is a pot with no exit: it can never be settled (the price is
            // unreadable) and reclaim() will not void it either. Refused at birth.
            h = new E2EHarness(XChainVM);
            h.seedBalance(MAKER, 'XCHAIN', '1000000');
            h.seedBalance(MAKER, TICK, '100');
            h.ledger.setTokenDecimals(TICK, 8);
            h.ledger.seedOracleRoundFloor(ROUND + 1);

            const r = await h.deploy({
                code: CODE, deployer: MAKER, contractAddress: ADDR,
                params: [MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(ROUND), '5']
            });
            // deploy() forwards initialize()'s full execute result under `result`,
            // which is what carries the atomicity fields assertReverted checks.
            assertReverted(r.result, 'older than the retrievable oracle window');
        });

        it('a bet on a FUTURE round still deploys, because absent is not evicted', async function () {
            // The guard must not read "not published yet" as "evicted": every honest
            // bet is made before its settle round exists.
            h = new E2EHarness(XChainVM);
            h.seedBalance(MAKER, 'XCHAIN', '1000000');
            h.seedBalance(MAKER, TICK, '100');
            h.ledger.setTokenDecimals(TICK, 8);
            h.ledger.seedOracleRoundFloor(ROUND - 2);          // the window starts below the bet

            assertSuccess(await h.deploy({
                code: CODE, deployer: MAKER, contractAddress: ADDR,
                params: [MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(ROUND), '5']
            }));
        });

        it('accept() refuses a bet whose round has already scrolled out', async function () {
            // Same free-option shape as the published-round snipe below: the taker
            // cannot see the price, but neither can the pot ever be settled or voided.
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            h.ledger.seedOracleRoundFloor(ROUND + 1);

            assertReverted(await depositAnd(TAKER, 'accept'),
                'older than the retrievable oracle window');
            assertContractState(h.ledger, ADDR, 'status', 'OPEN');
            // and the maker still gets out
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }));
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
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, v, '7', '5'])).success, false,
                    `stake ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, v, 'OVER', TICK, STAKE, '7', '5'])).success, false,
                    `strike ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('still accepts ordinary fixed-notation terms, trailing zeros included', async function () {
            for (const v of ['100', '0.5', '60000.00', '0.000000015', '999999999999']) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, v, '7', '5'])).success, true,
                    `stake ${JSON.stringify(v)} must deploy`);
            }
        });

        // Integer-shape gate on settleRound and deadlineBlocks. Both are raw
        // maker text, and a radix-less parseInt MEASURES them as something else
        // entirely: '1e2' is 1, '0x10' is 16, '7abc' is 7, ' 7' is 7, '5.99' is 5.
        // The old `parseInt(x) > 0` check then passes on the mis-measured value
        // and initialize() stores it, so a maker asking for a 100-block void
        // window via '1e2' silently gets a 1-block one and their matched bet is
        // reclaimable almost immediately.
        it('rejects integer params a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e2', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                         '+7', '', 'abc', '-', 'Infinity', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, v, '5'])).success, false,
                    `settleRound ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '7', v])).success, false,
                    `deadlineBlocks ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('rejects integer params outside their range and stores accepted ones verbatim', async function () {
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '7', '0'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '-7', '5'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '1000000001', '5'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '7', '1000001'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '1000000000', '1000000'])).success, true);

            // '100' means 100 blocks in state, not the 1 a parseInt of '1e2' gave.
            await deployBet('OVER', 100);
            assertContractState(h.ledger, ADDR, 'window', '100');
            assertContractState(h.ledger, ADDR, 'settleRound', String(ROUND));
        });
    });
});
