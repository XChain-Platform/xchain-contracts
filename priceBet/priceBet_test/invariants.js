// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// priceBet_test/invariants.js: seeded invariant tests for priceBet.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Two modelling choices sit on top of test/inproc/harness.js, both taken from the
// repo's own documentation of the VM:
//   - a SEND whose quantity normalises to exactly zero is a valid SEND that moves
//     nothing (cardDispenser.js, englishAuction.js), so it is skipped instead of
//     reverting the call; a negative quantity still reverts.
//   - a round below the oracle preload floor reads as
//     { price: null, roundNumber, timestamp: 0, outsideWindow: true }, the shape
//     the VM harness's seedOracleRoundFloor serves and priceBet.test.js relies on.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, M, bn, fixed, roundHalfUp } = require('../../test/inproc/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'priceBet.js'), 'utf8');
const ADDR = 'C:BTC:1';
const TICK = 'TEST';
const PAIR = 'BTC/USD';
const STRIKE = '60000';
const ROUND = 7;
const FUNDS = '1000000000000000000000000000000000000';
const ACTORS = ['maker', 'taker', 'stranger'];
const METHODS = ['fund', 'accept', 'settle', 'cancel', 'reclaim'];
// Weighted pick for the random walk: cancel is rare so matched paths get exercised.
const WALK = ['fund', 'fund', 'accept', 'accept', 'accept', 'settle', 'settle', 'reclaim', 'reclaim', 'cancel'];
const TERMINAL = ['SETTLED', 'PUSH', 'VOID', 'CANCELLED'];
const NEXT = { fund: ['INIT', 'OPEN'], accept: ['OPEN', 'MATCHED'], cancel: ['OPEN', 'CANCELLED'],
    reclaim: ['MATCHED', 'VOID'] };

class BetHarness extends Harness {
    constructor() { super(); this.roundFloor = 0; }
    applyActions(addr, actions) {
        const kept = [];
        for (const a of actions) {
            if (a.action === 'SEND' &&
                bn(roundHalfUp(a.params.quantity, this.ledger.decimals(a.params.tick))).isZero()) {
                a.settled = '0';
                continue;
            }
            kept.push(a);
        }
        super.applyActions(addr, kept);
    }
    makeApi(addr, params, caller, actions) {
        const api = super.makeApi(addr, params, caller, actions);
        const inner = api.oracle.getPriceAtRound;
        api.oracle.getPriceAtRound = (pair, r) => (this.roundFloor && r < this.roundFloor)
            ? { price: null, roundNumber: r, timestamp: 0, outsideWindow: true }
            : inner(pair, r);
        return api;
    }
}

function setup(opts) {
    const o = opts || {};
    const h = new BetHarness();
    h.ledger.setTokenDecimals(TICK, o.decimals === undefined ? 8 : o.decimals);
    for (const a of ACTORS) h.seedBalance(a, TICK, FUNDS);
    if (o.floor) h.roundFloor = o.floor;
    const r = h.deploy({ code: CODE, deployer: 'maker', contractAddress: ADDR,
        params: ['maker', PAIR, STRIKE, o.side || 'OVER', TICK, o.amount || '100',
            String(o.round === undefined ? ROUND : o.round), String(o.window === undefined ? 3 : o.window)] });
    h.deployResult = r;
    return h;
}

function publish(h, price, round) {
    const n = round || ROUND;
    const row = { price: price, roundNumber: n, timestamp: 1750000000 };
    h.ledger.oracle.rounds[PAIR] = Object.assign(h.ledger.oracle.rounds[PAIR] || {}, { [n]: row });
    h.ledger.oracle.prices[PAIR] = row;
}

const run = (h, method, caller) => h.execute({ contractAddress: ADDR, method: method, params: [], caller: caller });
const held = (h) => h.ledger.getBalance(ADDR, TICK);
const bal = (h, who) => h.ledger.getBalance(who, TICK);
const delta = (after, before) => fixed(bn(after).minus(bn(before)));
const same = (a, b) => bn(a).eq(bn(b));
const floorGrid = (v, d) => bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_DOWN).toFixed();
const ceilGrid = (v, d) => bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_UP).toFixed();
const unit = (d) => (d === 0 ? '1' : '0.' + '0'.repeat(d - 1) + '1');

function publishedPrice(h) {
    const m = h.ledger.oracle.rounds[PAIR] || {};
    if (h.roundFloor && ROUND < h.roundFloor) return null;
    return m[ROUND] ? m[ROUND].price : null;
}

function matchedBet(opts) {
    const h = setup(opts);
    assert.ok(h.deployResult.success, h.deployResult.error);
    const amt = (opts && opts.amount) || '100';
    const d = (opts && opts.decimals !== undefined) ? opts.decimals : 8;
    h.deposit('maker', ADDR, TICK, ceilGrid(amt, d));
    assert.ok(run(h, 'fund', 'maker').success);
    h.deposit('taker', ADDR, TICK, ceilGrid(amt, d));
    const r = run(h, 'accept', 'taker');
    assert.ok(r.success, r.error);
    return h;
}

// One random step's expectations, checked against the state before and after it.
function checkStep(h, ctx, method, caller, before, r) {
    const st = h.state(ADDR, 'status');
    if (!r.success) {
        assert.strictEqual(st, before.status, ctx + ': failed call changed status');
        return 0;
    }
    assert.ok(TERMINAL.indexOf(before.status) < 0, ctx + ': ' + method + ' succeeded on terminal ' + before.status);
    if (method === 'settle') {
        assert.strictEqual(before.status, 'MATCHED', ctx);
        assert.notStrictEqual(before.price, null, ctx + ': settle without a published round');
        const c = bn(before.price).comparedTo(bn(STRIKE));
        if (c === 0) assert.strictEqual(st, 'PUSH', ctx);
        else {
            assert.strictEqual(st, 'SETTLED', ctx);
            const makerWins = (c > 0) === (h.state(ADDR, 'side') === 'OVER');
            const w = makerWins ? 'maker' : h.state(ADDR, 'taker');
            assert.strictEqual(h.state(ADDR, 'winner'), w, ctx + ': wrong winner');
            assert.ok(same(delta(bal(h, w), before[w]), before.held), ctx + ': winner not paid the pot');
        }
    } else {
        assert.deepStrictEqual([before.status, st], NEXT[method], ctx + ': bad transition for ' + method);
    }
    if (method === 'accept') {
        assert.notStrictEqual(caller, 'maker', ctx);
        assert.strictEqual(before.price, null, ctx + ': accept after the round was published');
    }
    if (method === 'reclaim') {
        assert.ok(caller === 'maker' || caller === h.state(ADDR, 'taker'), ctx + ': reclaim by a non-party');
        assert.strictEqual(before.price, null, ctx + ': reclaim of a published round');
        assert.ok(h.ledger.blockHeight >= parseInt(h.state(ADDR, 'deadline'), 10), ctx);
    }
    if (method === 'fund' || method === 'cancel') assert.strictEqual(caller, 'maker', ctx);
    if (st === 'PUSH' || st === 'VOID') {
        const mk = floorGrid(h.state(ADDR, 'amount'), h.ledger.decimals(TICK));
        assert.ok(same(delta(bal(h, 'maker'), before.maker), mk), ctx + ': maker refund leg');
        const tk = h.state(ADDR, 'taker');
        assert.ok(same(delta(bal(h, tk), before[tk]), fixed(bn(before.held).minus(bn(mk)))), ctx + ': taker leg');
    }
    if (st === 'CANCELLED') assert.ok(same(delta(bal(h, 'maker'), before.maker), before.held), ctx);
    if (TERMINAL.indexOf(st) >= 0) assert.ok(bn(held(h)).isZero(), ctx + ': custody left after ' + st);
    return r.actions.filter((a) => a.action === 'SEND').length > 0 ? 1 : 0;
}

(available ? describe : describe.skip)('priceBet invariants (in-process)', function () {
    const AMOUNTS = ['100', '1', '0.00000001', '0.000000015', '1.5', '123456789012345678901234567890'];
    const PRICES = ['59999.99999999', '60000', '60000.000', '60000.00000001', '1', '1000000000000'];

    it('conservation, valid transitions and single payout across seeded random call sequences', function () {
        for (let seed = 1; seed <= 300; seed++) {
            const R = rng(seed);
            const d = R.pick([0, 2, 8, 18]);
            const amount = R.pick(AMOUNTS);
            const h = setup({ decimals: d, amount: amount, side: R.pick(['OVER', 'UNDER']), window: R.int(1, 4) });
            assert.ok(h.deployResult.success, 'seed ' + seed + ': ' + h.deployResult.error);
            const supply = h.ledger.total(TICK);
            let payouts = 0;
            for (let step = 0; step < 30; step++) {
                if (R.next() < 0.35) {
                    const q = R.pick([ceilGrid(amount, d), ceilGrid(fixed(bn(amount).times(2)), d), unit(d),
                        String(R.int(1, 200))]);
                    h.deposit(R.pick(ACTORS), ADDR, TICK, q);
                }
                if (R.next() < 0.2) h.mineBlock(R.int(1, 2));
                if (R.next() < 0.08 && publishedPrice(h) === null) publish(h, R.pick(PRICES));
                if (R.next() < 0.03) h.roundFloor = ROUND + 1;
                const method = R.pick(WALK);
                const caller = R.pick(ACTORS);
                const before = { status: h.state(ADDR, 'status'), held: held(h), maker: bal(h, 'maker'),
                    taker: bal(h, 'taker'), stranger: bal(h, 'stranger'), price: publishedPrice(h) };
                const r = run(h, method, caller);
                const ctx = 'seed ' + seed + ' step ' + step + ' ' + method + ' by ' + caller;
                payouts += checkStep(h, ctx, method, caller, before, r);
                assert.strictEqual(h.ledger.total(TICK), supply, ctx + ': supply drift');
            }
            assert.ok(payouts <= 1, 'seed ' + seed + ': more than one payout transition (' + payouts + ')');
        }
    });

    it('lifecycle: every terminal status refuses every state-changing method', function () {
        const ends = {
            SETTLED: (h) => { publish(h, '61000'); return run(h, 'settle', 'stranger'); },
            PUSH: (h) => { publish(h, STRIKE); return run(h, 'settle', 'stranger'); },
            VOID: (h) => { h.mineBlock(3); return run(h, 'reclaim', 'taker'); }
        };
        for (const k of Object.keys(ends)) {
            const h = matchedBet();
            assert.ok(ends[k](h).success, k);
            assert.strictEqual(h.state(ADDR, 'status'), k);
            h.deposit('stranger', ADDR, TICK, '500');
            publish(h, '61000');
            for (const m of METHODS) for (const c of ACTORS)
                assert.ok(!run(h, m, c).success, k + ': ' + m + ' by ' + c);
        }
        const h = setup();
        h.deposit('maker', ADDR, TICK, '100');
        assert.ok(run(h, 'fund', 'maker').success);
        assert.ok(run(h, 'cancel', 'maker').success);
        h.deposit('maker', ADDR, TICK, '300');
        for (const m of METHODS) for (const c of ACTORS) assert.ok(!run(h, m, c).success, 'CANCELLED: ' + m + ' by ' + c);
    });

    it('authorization: fund and cancel are maker-only, reclaim is party-only, accept refuses the maker', function () {
        for (const c of ACTORS) {
            const h = setup();
            h.deposit('maker', ADDR, TICK, '100');
            assert.strictEqual(run(h, 'fund', c).success, c === 'maker', 'fund by ' + c);
        }
        for (const c of ACTORS) {
            const h = setup();
            h.deposit('maker', ADDR, TICK, '100');
            run(h, 'fund', 'maker');
            assert.strictEqual(run(h, 'cancel', c).success, c === 'maker', 'cancel by ' + c);
        }
        for (const c of ACTORS) {
            const h = setup();
            h.deposit('maker', ADDR, TICK, '300');
            run(h, 'fund', 'maker');
            assert.strictEqual(run(h, 'accept', c).success, c !== 'maker', 'accept by ' + c);
        }
        for (const c of ACTORS) {
            const h = matchedBet();
            h.mineBlock(3);
            assert.strictEqual(run(h, 'reclaim', c).success, c !== 'stranger', 'reclaim by ' + c);
        }
        for (const c of ACTORS) {
            const h = matchedBet();
            publish(h, '61000');
            assert.ok(run(h, 'settle', c).success, 'settle is permissionless: ' + c);
        }
    });

    it('fund and accept are exact to one base unit at 0, 8 and 18 decimals', function () {
        for (const d of [0, 8, 18]) {
            const amt = '1000000';
            const h = setup({ decimals: d, amount: amt });
            const u = unit(d);
            h.deposit('maker', ADDR, TICK, fixed(bn(amt).minus(bn(u))));
            assert.ok(!run(h, 'fund', 'maker').success, d + ': fund one unit short');
            h.deposit('maker', ADDR, TICK, u);
            assert.ok(run(h, 'fund', 'maker').success, d + ': fund exact');
            h.deposit('taker', ADDR, TICK, fixed(bn(amt).minus(bn(u))));
            assert.ok(!run(h, 'accept', 'taker').success, d + ': accept one unit short');
            h.deposit('taker', ADDR, TICK, u);
            assert.ok(run(h, 'accept', 'taker').success, d + ': accept exact');
        }
    });

    it('settlement is exact to one base unit around the strike', function () {
        const cases = [['60000.00000001', 'maker'], ['59999.99999999', 'taker'], ['60000.0', null]];
        for (const [p, w] of cases) {
            const h = matchedBet();
            publish(h, p);
            assert.ok(run(h, 'settle', 'stranger').success);
            assert.strictEqual(h.state(ADDR, 'winner'), w, p);
            assert.ok(bn(held(h)).isZero());
        }
    });

    it('huge stake: a 31-digit stake pushes and voids exactly', function () {
        const big = '1234567890123456789012345678901';
        const h = matchedBet({ amount: big });
        publish(h, STRIKE);
        assert.ok(run(h, 'settle', 'stranger').success);
        assert.strictEqual(bal(h, 'maker'), FUNDS);
        assert.strictEqual(bal(h, 'taker'), FUNDS);
        const v = matchedBet({ amount: big });
        v.mineBlock(3);
        assert.ok(run(v, 'reclaim', 'maker').success);
        assert.strictEqual(bal(v, 'maker'), FUNDS);
    });

    it('reclaim honours the deadline boundary and cannot void a published or evicted round', function () {
        const h = matchedBet({ window: 3 });
        h.mineBlock(2);
        assert.ok(!run(h, 'reclaim', 'maker').success, 'one block early');
        h.mineBlock(1);
        publish(h, '59000');
        assert.ok(!run(h, 'reclaim', 'maker').success, 'published round');
        h.roundFloor = ROUND + 1;
        assert.ok(!run(h, 'reclaim', 'maker').success, 'evicted round');
        assert.strictEqual(h.state(ADDR, 'status'), 'MATCHED');
        const g = matchedBet({ window: 3 });
        g.mineBlock(3);
        assert.ok(run(g, 'reclaim', 'maker').success, 'exact deadline, round absent');
    });

    it('constructor boundaries: zero, non-plain, and out-of-range terms revert; an evicted round is refused', function () {
        const bad = [{ amount: '0' }, { amount: '1e2' }, { round: 0 }, { round: 1000000001 }, { window: 0 },
            { window: 1000001 }, { floor: ROUND + 1 }];
        for (const b of bad) assert.ok(!setup(b).deployResult.success, JSON.stringify(b));
        assert.ok(setup({ round: 1000000000, window: 1000000 }).deployResult.success);
    });

    it('determinism: the template never touches Date or Math.random on any path', function () {
        const h = matchedBet();
        publish(h, '61000');
        const r = run(h, 'settle', 'stranger');
        assert.ok(r.success, r.error);
        assert.doesNotMatch(CODE, /Date\.|Math\.random|for\s*\(\s*var\s+\w+\s+in\b/);
    });

    // NOTE (documented behaviour, not a finding): accept() measures the whole pot
    // against 2 x amount, so a maker over-deposit or a sub-base-unit stake lets a
    // taker match while depositing less than `amount`, and the push/void refund
    // floors the maker leg, routing the residue to the taker. The README states
    // the over-deposit and floor rules; this pins the consequence.
    it('NOTE: a sub-base-unit stake is matched with no taker deposit and refunds the maker zero', function () {
        const h = setup({ amount: '0.000000001', decimals: 8 });
        h.deposit('maker', ADDR, TICK, '0.00000001');
        assert.ok(run(h, 'fund', 'maker').success);
        assert.ok(run(h, 'accept', 'taker').success, 'taker matched without depositing');
        publish(h, STRIKE);
        assert.ok(run(h, 'settle', 'stranger').success);
        assert.strictEqual(bal(h, 'taker'), fixed(bn(FUNDS).plus(bn('0.00000001'))));
    });
});
