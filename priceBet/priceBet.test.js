// SPDX-License-Identifier: MIT
// XChain Platform: Contract Template Library
// priceBet.test.js: behavioral + adversarial tests for priceBet.js
// Copyright (c) 2026 Dankest, LLC. MIT License.
// Runs against the real VM via xchain-vm's E2E harness, loading the ACTUAL priceBet.js.
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

const [MAKER, TAKER, STRANGER] = ['maker', 'taker', 'stranger'];
const [ADDR, TICK, PAIR, STRIKE, STAKE, ROUND] = ['C:BTC:1', 'TEST', 'BTC/USD', '60000', '100', 7];
let cur;  // current harness, kept in step with ctx.h by makeFixtures
const state = (k, v) => assertContractState(cur.ledger, ADDR, k, v);
const held = (v) => assertContractBalance(cur.ledger, ADDR, TICK, v);
const bal = (who, tick, v) => assertBalance(cur.ledger, who, tick, v);

// Happy paths that settle on a published round: OVER wins, OVER loses, UNDER wins.
function registerSettleOutcomes(ctx) {
    const { deployBet, depositAnd, publishRound, run, settle, matched } = ctx;
    it('round above the strike: OVER maker takes the whole pot', async function () {
        await deployBet('OVER');
        assertSuccess(await depositAnd(MAKER, 'fund')); state('status', 'OPEN');
        assertSuccess(await depositAnd(TAKER, 'accept')); state('status', 'MATCHED');

        publishRound('61000');
        const r = await settle();
        assertSuccess(r);
        assertEmittedActions(r, [{ action: 'SEND', params: { destination: MAKER, tick: TICK, quantity: '200' } }]);
        bal(MAKER, TICK, '200'); held('0'); state('status', 'SETTLED'); state('winner', MAKER);
    });
    it('round below the strike: OVER maker loses, taker takes the pot', async function () {
        await matched('OVER');
        publishRound('59000');
        assertSuccess(await settle());
        bal(TAKER, TICK, '200'); state('winner', TAKER);
    });
    it('UNDER maker wins when the round is below the strike', async function () {
        await matched('UNDER');
        publishRound('59999.99');
        assertSuccess(await settle());
        bal(MAKER, TICK, '200');
    });
}

// Happy paths that push at the strike, on the tick grid and half a base unit off it.
function registerPushRefunds(ctx) {
    const { depositAnd, publishRound, settle, matched, freshBet } = ctx;
    it('payout guards use exact comparisons', function () {
        assert.doesNotMatch(CODE, /math\.gt\(rest, '0'\)/);
    });
    it('round exactly at the strike: push, both stakes returned', async function () {
        await matched('OVER');
        publishRound(STRIKE);
        assertSuccess(await settle());
        bal(MAKER, TICK, '100'); bal(TAKER, TICK, '100'); held('0'); state('status', 'PUSH');
    });
    it('half-ulp off-grid stake still pushes: both refund legs land on the tick grid', async function () {
        await freshBet({ funds: '1', decimals: 8, stake: '0.000000015' });
        assertSuccess(await depositAnd(MAKER, 'fund', '0.00000002'));
        assertSuccess(await depositAnd(TAKER, 'accept', '0.00000002')); publishRound(STRIKE);
        assertSuccess(await settle());

        bal(MAKER, TICK, '0.99999999'); bal(TAKER, TICK, '1.00000001'); held('0'); state('status', 'PUSH');
    });
    it('a one-unit 18-decimal residual is paid to the taker', async function () {
        assertSuccess(await freshBet({ funds: '1', decimals: 18, stake: '1' }));
        assertSuccess(await depositAnd(MAKER, 'fund', '1')); assertSuccess(await depositAnd(TAKER, 'accept', '1'));
        ctx.h.ledger.debitContractBalance(ADDR, TICK, '0.999999999999999999');

        publishRound(STRIKE);
        assertSuccess(await settle());
        bal(MAKER, TICK, '1'); bal(TAKER, TICK, '0.000000000000000001'); held('0');
    });
}

// Happy paths that end with no winner: an unmatched cancel and a void past the deadline.
function registerCancelAndVoid(ctx) {
    const { deployBet, depositAnd, run, matched, mine } = ctx;
    it('maker cancels an unmatched bet and recovers their stake', async function () {
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        assertSuccess(await run('cancel', MAKER));
        bal(MAKER, TICK, '100'); state('status', 'CANCELLED');
    });
    it('oracle never publishes the round: either party voids after the deadline', async function () {
        await matched('OVER', 3);
        assertReverted(await run('reclaim', TAKER), 'deadline not reached');
        mine(3);
        assertSuccess(await run('reclaim', TAKER));
        bal(MAKER, TICK, '100'); bal(TAKER, TICK, '100'); state('status', 'VOID');
    });
}

function registerNearStrikeSuite(ctx) {
    const { publishRound, settle, matched } = ctx;
    describe('near-strike settlement is exact', function () {
        async function settleAt(side, price) {
            await matched(side);
            publishRound(price);
            assertSuccess(await settle());
        }
        it('one base unit above the strike: OVER maker wins, no push', async function () {
            await settleAt('OVER', '60000.00000001');
            state('status', 'SETTLED'); state('winner', MAKER); bal(MAKER, TICK, '200');
        });
        it('one base unit below the strike: OVER maker loses to the taker', async function () {
            await settleAt('OVER', '59999.99999999');
            state('status', 'SETTLED'); state('winner', TAKER); bal(TAKER, TICK, '200');
        });
        it('one base unit below the strike: UNDER maker wins', async function () {
            await settleAt('UNDER', '59999.99999999');
            state('winner', MAKER); bal(MAKER, TICK, '200');
        });
        it('a differently spelled equal price still pushes', async function () {
            await settleAt('OVER', '60000.000');
            state('status', 'PUSH'); bal(MAKER, TICK, '100'); bal(TAKER, TICK, '100');
        });
    });
}

// Settle timing: an unpublished round, a dodged loss and a snipe on a published round.
function registerSettleTimingAttacks(ctx) {
    const { deployBet, depositAnd, publishRound, run, settle, matched, mine } = ctx;
    it('settle before the round is published reverts', async function () {
        await matched('OVER');
        ctx.h.ledger.seedOracle(PAIR, '65000', 0, {});
        assertReverted(await settle(), 'not published');
        state('status', 'MATCHED');
    });
    it('reclaim() cannot dodge a lost bet once the round exists', async function () {
        await matched('OVER', 3);
        mine(3); // past the deadline
        publishRound('59000'); // maker (OVER) lost
        assertReverted(await run('reclaim', MAKER), 'settle() instead');
        assertSuccess(await run('settle', TAKER));
        bal(TAKER, TICK, '200');
    });
    it('an OPEN bet cannot be sniped once the settle round is published', async function () {
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        state('status', 'OPEN');

        publishRound('59000'); // below the strike: the OVER maker has lost
        assertReverted(await depositAnd(TAKER, 'accept'), 'settle round already published');
        state('status', 'OPEN');

        assertSuccess(await run('cancel', MAKER));
        state('status', 'CANCELLED');
    });
}

// The oracle window floor as reclaim() sees it, outside and inside the window.
function registerWindowReclaimAttacks(ctx) {
    const { publishRound, run, matched, mine } = ctx;
    it('the loser cannot reclaim a decided bet by waiting for the round to scroll out', async function () {
        await matched('OVER', 3);
        mine(3);

        publishRound('59000');
        ctx.h.ledger.seedOracle(PAIR, '65000', 0, {});
        ctx.h.ledger.seedOracleRoundFloor(ROUND + 1);

        assertReverted(await run('reclaim', MAKER), 'outside the retrievable oracle window');
        state('status', 'MATCHED'); held('200'); bal(MAKER, TICK, '0');
    });
    it('an unpublished round INSIDE the window still voids, so the hatch still works', async function () {
        await matched('OVER', 3);
        mine(3);
        ctx.h.ledger.seedOracleRoundFloor(ROUND);

        assertSuccess(await run('reclaim', TAKER));
        state('status', 'VOID'); bal(MAKER, TICK, '100'); bal(TAKER, TICK, '100');
    });
}

// The oracle window floor as deploy and accept() see it.
function registerWindowDeployAttacks(ctx) {
    const { deployBet, depositAnd, run, freshBet } = ctx;
    it('a bet on an already-evicted round is refused at deploy', async function () {
        const r = await freshBet({ funds: '100', decimals: 8, stake: STAKE, floor: ROUND + 1 });
        assertReverted(r.result, 'older than the retrievable oracle window');
    });
    it('a bet on a FUTURE round still deploys, because absent is not evicted', async function () {
        assertSuccess(await freshBet({ funds: '100', decimals: 8, stake: STAKE, floor: ROUND - 2 }));
    });
    it('accept() refuses a bet whose round has already scrolled out', async function () {
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        ctx.h.ledger.seedOracleRoundFloor(ROUND + 1);

        assertReverted(await depositAnd(TAKER, 'accept'), 'older than the retrievable oracle window');
        state('status', 'OPEN');
        assertSuccess(await run('cancel', MAKER));
    });
}

// Funding: underfunded deposits, base-unit exactness and a maker taking their own bet.
function registerFundingAttacks(ctx) {
    const { deployBet, depositAnd, freshBet } = ctx;
    it('underfunded fund() and accept() revert (no trust in caller-supplied amounts)', async function () {
        await deployBet('OVER');
        assertReverted(await depositAnd(MAKER, 'fund', '50'), 'insufficient deposit');
        state('status', 'INIT'); assertSuccess(await depositAnd(MAKER, 'fund', '50')); // 50 + 50 = 100 held
        assertReverted(await depositAnd(TAKER, 'accept', '50'), 'insufficient deposit');
        state('status', 'OPEN');
    });
    it('fund() and accept() are exact to the base unit on a large stake', async function () {
        assertSuccess(await freshBet({ funds: '1000000', decimals: 8, stake: '1000000' }));
        assertReverted(await depositAnd(MAKER, 'fund', '999999.99999999'), 'insufficient deposit');
        assertSuccess(await depositAnd(MAKER, 'fund', '0.00000001'));
        assertReverted(await depositAnd(TAKER, 'accept', '999999.99999999'), 'insufficient deposit');
        assertSuccess(await depositAnd(TAKER, 'accept', '0.00000001')); state('status', 'MATCHED');
    });
    it('the maker cannot take their own bet', async function () {
        await deployBet('OVER');
        ctx.h.seedBalance(MAKER, TICK, '300');
        await depositAnd(MAKER, 'fund');
        assertReverted(await depositAnd(MAKER, 'accept'), 'cannot take their own bet');
    });
}

// Status guards on settle, cancel, reclaim and accept.
function registerLifecycleAttacks(ctx) {
    const { deployBet, depositAnd, publishRound, run, settle, matched, mine } = ctx;
    it('double-settle is impossible: the status guard blocks any second payout', async function () {
        await matched('OVER');
        publishRound('61000');
        assertSuccess(await settle());
        assertReverted(await settle(), 'already settled');
        held('0'); // no second payout
    });
    it('cancel is maker-only and impossible once matched', async function () {
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        assertReverted(await run('cancel', STRANGER), 'only the maker');
        await depositAnd(TAKER, 'accept');
        assertReverted(await run('cancel', MAKER), 'not open');
    });
    it('reclaim is party-only', async function () {
        await matched('OVER', 3);
        mine(3);
        assertReverted(await run('reclaim', STRANGER), 'not a party');
    });
    it('accept before fund reverts', async function () {
        await deployBet('OVER');
        assertReverted(await depositAnd(TAKER, 'accept'), 'not open');
    });
}

// Stake and strike spelling: notations the refund floor cannot handle, and plain terms.
function registerTermValidation(deployWith) {
    const terms = (stake, strike, round, window) =>
        [MAKER, PAIR, strike || STRIKE, 'OVER', TICK, stake || STAKE, round || '7', window || '5'];
    const deploys = async (params) => (await deployWith(params)).success;
    it('rejects an invalid side', async function () {
        const r = await deployWith([MAKER, PAIR, STRIKE, 'ABOVE', TICK, STAKE, '7', '5']);
        assert.strictEqual(r.success, false, 'side=ABOVE should revert in initialize');
    });
    it('rejects a non-positive stake and a non-positive round', async function () {
        assert.strictEqual(await deploys(terms('0')), false);
        assert.strictEqual(await deploys(terms(STAKE, STRIKE, '0')), false);
    });

    it('rejects every non-fixed-notation spelling of stake and strike', async function () {
        const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                     '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                     'Infinity', 'NaN', '1.2.3'];
        for (const v of BAD) {
            assert.strictEqual(await deploys(terms(v)), false, `stake ${JSON.stringify(v)} must not deploy`);
            assert.strictEqual(await deploys(terms(STAKE, v)), false, `strike ${JSON.stringify(v)} must not deploy`);
        }
    });
    it('still accepts ordinary fixed-notation terms, trailing zeros included', async function () {
        for (const v of ['100', '0.5', '60000.00', '0.000000015', '999999999999']) {
            assert.strictEqual(await deploys(terms(v)), true, `stake ${JSON.stringify(v)} must deploy`);
        }
    });
}

// settleRound and deadlineBlocks: integer shape, range, and the value stored.
function registerIntegerValidation(ctx, deployWith) {
    const { deployBet } = ctx;
    const deploys = async (round, window) =>
        (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, round, window])).success;
    it('rejects integer params a radix-less parseInt would silently re-measure', async function () {
        const BAD = ['1e2', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                     '+7', '', 'abc', '-', 'Infinity', 'NaN'];
        for (const v of BAD) {
            assert.strictEqual(await deploys(v, '5'), false, `settleRound ${JSON.stringify(v)} must not deploy`);
            assert.strictEqual(await deploys('7', v), false, `deadlineBlocks ${JSON.stringify(v)} must not deploy`);
        }
    });
    it('rejects integer params outside their range and stores accepted ones verbatim', async function () {
        assert.strictEqual(await deploys('7', '0'), false);
        assert.strictEqual(await deploys('-7', '5'), false);
        assert.strictEqual(await deploys('1000000001', '5'), false);
        assert.strictEqual(await deploys('7', '1000001'), false);
        assert.strictEqual(await deploys('1000000000', '1000000'), true);

        await deployBet('OVER', 100);
        state('window', '100'); state('settleRound', String(ROUND));
    });
}

// Deploy-time parameter validation, each bad case on a throwaway harness.
function registerDeployValidationSuite(ctx) {
    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(MAKER, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: MAKER, contractAddress: 'C:BTC:2', params: params });
        }

        registerTermValidation(deployWith); registerIntegerValidation(ctx, deployWith);
    });
}

// Test fixtures bound to the current harness; registrars reach it through ctx.h.
function makeFixtures(ctx) {
    async function freshBet({ funds, decimals, stake, floor, side, window }) {
        const h = ctx.h = new E2EHarness(XChainVM);
        h.seedBalance(MAKER, 'XCHAIN', '1000000');
        h.seedBalance(MAKER, TICK, funds);
        h.seedBalance(TAKER, TICK, funds);
        h.ledger.setTokenDecimals(TICK, decimals);
        if (floor !== undefined) h.ledger.seedOracleRoundFloor(floor);
        return h.deploy({
            code: CODE, deployer: MAKER, contractAddress: ADDR,
            params: [MAKER, PAIR, STRIKE, side || 'OVER', TICK, stake, String(ROUND), String(window || 5)]
        });
    }

    const deployBet = (side, window) => freshBet({ funds: '100', decimals: 8, stake: STAKE, side, window });

    async function depositAnd(who, method, amount) {
        ctx.h.deposit(who, ADDR, TICK, amount || STAKE);
        return run(method, who);
    }

    const run = (method, caller) =>
        ctx.h.execute({ contractAddress: ADDR, method: method, params: [], caller: caller });
    const settle = () => run('settle', STRANGER);
    const mine = (n) => { for (let i = 0; i < n; i++) ctx.h.mineBlock(); };

    async function matched(side, window) {
        await deployBet(side, window);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
    }

    function publishRound(price) {
        const rounds = { [ROUND]: { price: price, roundNumber: ROUND, timestamp: 1750000000 } };
        ctx.h.ledger.seedOracle(PAIR, price, 0, rounds);
    }

    return { deployBet, freshBet, depositAnd, run, settle, mine, matched, publishRound };
}

(XChainVM ? describe : describe.skip)('Template: priceBet', function () {
    this.timeout(0);
    const ctx = { get h() { return cur; }, set h(v) { cur = v; } };
    Object.assign(ctx, makeFixtures(ctx));

    describe('happy paths', function () {
        registerSettleOutcomes(ctx);
        registerPushRefunds(ctx);
        registerCancelAndVoid(ctx);
    });

    registerNearStrikeSuite(ctx);
    describe('attacks we considered', function () {
        registerSettleTimingAttacks(ctx);
        registerWindowReclaimAttacks(ctx);
        registerWindowDeployAttacks(ctx);
        registerFundingAttacks(ctx);
        registerLifecycleAttacks(ctx);
    });
    registerDeployValidationSuite(ctx);
});
