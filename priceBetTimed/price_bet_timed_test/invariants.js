// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// price_bet_timed_test/invariants.js: seeded invariant tests for priceBetTimed.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Two modelling choices sit on top of test/inproc/harness.js, both taken from the
// repo's own documentation of the VM:
//   - a SEND whose quantity normalises to exactly zero is a valid SEND that moves
//     nothing (cardDispenser.js, englishAuction.js), so it is skipped instead of
//     reverting the call; a negative quantity still reverts.
//   - a round below the oracle preload floor reads as
//     { price: null, roundNumber, timestamp: 0, outsideWindow: true } whether or
//     not the pair ever published it, the shape the VM harness's
//     seedOracleRoundFloor serves and the existing window tests rely on.
// Rounds are seeded in the production accessor shape { price, roundNumber,
// timestamp }, and getPrice() serves the highest seeded round, as publishRounds()
// in priceBetTimed.test.js does.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, M, bn, fixed, roundHalfUp } = require('../../test/inproc/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'priceBetTimed.js'), 'utf8');
const ADDR = 'C:BTC:1';
const TICK = 'TEST';
const PAIR = 'BTC/USD';
const STRIKE = '60000';
const T0 = 1700000000;   // harness block-time anchor
const T = T0 + 1500;     // settle time, 2.5 blocks after deploy at 600 s per block
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

// Add rounds { n: { ts, price } } to the pair's history; the highest becomes the tip.
function publish(h, spec) {
    const rows = h.ledger.oracle.rounds[PAIR] = h.ledger.oracle.rounds[PAIR] || {};
    for (const n of Object.keys(spec)) rows[n] = { price: spec[n].price, roundNumber: Number(n), timestamp: spec[n].ts };
    const top = Math.max.apply(null, Object.keys(rows).map(Number));
    h.ledger.oracle.prices[PAIR] = rows[top];
}
function history(h) { return h.ledger.oracle.rounds[PAIR] || {}; }
function tip(h) { const p = h.ledger.oracle.prices[PAIR]; return p ? p.roundNumber : null; }

// First round at or above `from` whose timestamp reaches T, read off the seeded history.
function decidingRound(h, from) {
    const rows = history(h);
    const ns = Object.keys(rows).map(Number).filter((n) => n >= from).sort((a, b) => a - b);
    for (const n of ns) if (rows[n].timestamp >= T) return rows[n];
    return null;
}

function setup(opts) {
    const o = opts || {};
    const h = new BetHarness();
    h.ledger.setTokenDecimals(TICK, o.decimals === undefined ? 8 : o.decimals);
    for (const a of ACTORS) h.seedBalance(a, TICK, FUNDS);
    const r = h.deploy({ code: CODE, deployer: 'maker', contractAddress: ADDR,
        params: ['maker', PAIR, STRIKE, o.side || 'OVER', TICK, o.amount || '100',
            String(o.settleTime === undefined ? T : o.settleTime), String(o.window === undefined ? 3 : o.window)] });
    h.deployResult = r;
    publish(h, { 1: { ts: T0, price: '59000' } });
    return h;
}

const run = (h, method, caller) => h.execute({ contractAddress: ADDR, method: method, params: [], caller: caller });
const held = (h) => h.ledger.getBalance(ADDR, TICK);
const bal = (h, who) => h.ledger.getBalance(who, TICK);
const delta = (after, before) => fixed(bn(after).minus(bn(before)));
const same = (a, b) => bn(a).eq(bn(b));
const floorGrid = (v, d) => bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_DOWN).toFixed();
const ceilGrid = (v, d) => bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_UP).toFixed();
const unit = (d) => (d === 0 ? '1' : '0.' + '0'.repeat(d - 1) + '1');

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

function checkSettle(h, ctx, before, r, st) {
    const decided = decidingRound(h, before.acceptCursor);
    if (st === 'MATCHED') {
        assert.ok(r.result === 'PENDING' || r.result === 'SCANNING', ctx + ': ' + r.result);
        assert.strictEqual(r.actions.length, 0, ctx);
        if (r.result === 'PENDING') assert.strictEqual(decided, null, ctx + ': PENDING while a deciding round exists');
        return;
    }
    assert.notStrictEqual(decided, null, ctx + ': settled with no deciding round');
    assert.strictEqual(r.result, st, ctx);
    const c = bn(decided.price).comparedTo(bn(STRIKE));
    if (c === 0) { assert.strictEqual(st, 'PUSH', ctx); return; }
    assert.strictEqual(st, 'SETTLED', ctx);
    assert.strictEqual(h.state(ADDR, 'settledRound'), String(decided.roundNumber), ctx + ': wrong deciding round');
    const makerWins = (c > 0) === (h.state(ADDR, 'side') === 'OVER');
    const w = makerWins ? 'maker' : h.state(ADDR, 'taker');
    assert.strictEqual(h.state(ADDR, 'winner'), w, ctx + ': wrong winner');
    assert.ok(same(delta(bal(h, w), before[w]), before.held), ctx + ': winner not paid the pot');
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
        checkSettle(h, ctx, before, r, st);
    } else {
        assert.deepStrictEqual([before.status, st], NEXT[method], ctx + ': bad transition for ' + method);
    }
    if (method === 'accept') {
        assert.notStrictEqual(caller, 'maker', ctx);
        assert.ok(before.blockTs < T, ctx + ': accept after settleTime');
        assert.strictEqual(h.state(ADDR, 'cursor'), String(before.tip), ctx + ': cursor not anchored at the tip');
        // The outcome must still be open at the match: no round the scan will read
        // may already reach settleTime, or the taker is buying a known result.
        assert.strictEqual(decidingRound(h, before.tip), null,
            ctx + ': accept matched a bet whose deciding round is already published');
    }
    if (method === 'reclaim') {
        assert.ok(caller === 'maker' || caller === h.state(ADDR, 'taker'), ctx + ': reclaim by a non-party');
        assert.ok(h.ledger.blockHeight >= parseInt(h.state(ADDR, 'deadline'), 10), ctx);
        assert.strictEqual(decidingRound(h, before.acceptCursor), null, ctx + ': void of a decided bet');
    }
    if (method === 'fund' || method === 'cancel') assert.strictEqual(caller, 'maker', ctx);
    if (st === 'PUSH' || st === 'VOID') {
        const mk = floorGrid(h.state(ADDR, 'amount'), h.ledger.decimals(TICK));
        const tk = h.state(ADDR, 'taker');
        assert.ok(same(delta(bal(h, 'maker'), before.maker), mk), ctx + ': maker refund leg');
        assert.ok(same(delta(bal(h, tk), before[tk]), fixed(bn(before.held).minus(bn(mk)))), ctx + ': taker leg');
    }
    if (st === 'CANCELLED') assert.ok(same(delta(bal(h, 'maker'), before.maker), before.held), ctx);
    if (TERMINAL.indexOf(st) >= 0) assert.ok(bn(held(h)).isZero(), ctx + ': custody left after ' + st);
    return TERMINAL.indexOf(st) >= 0 ? 1 : 0;
}

(available ? describe : describe.skip)('priceBetTimed invariants (in-process)', function () {
    const AMOUNTS = ['100', '1', '0.00000001', '0.000000015', '1.5', '123456789012345678901234567890'];
    const PRICES = ['59999.99999999', '60000', '60000.000', '60000.00000001', '1', '1000000000000'];

    it('conservation, valid transitions, deciding-round choice and single payout across seeded random sequences', function () {
        for (let seed = 1; seed <= 300; seed++) {
            const R = rng(seed);
            const d = R.pick([0, 2, 8, 18]);
            const amount = R.pick(AMOUNTS);
            const h = setup({ decimals: d, amount: amount, side: R.pick(['OVER', 'UNDER']), window: R.int(1, 4) });
            assert.ok(h.deployResult.success, 'seed ' + seed + ': ' + h.deployResult.error);
            const supply = h.ledger.total(TICK);
            let acceptCursor = null;
            let payouts = 0;
            for (let step = 0; step < 30; step++) {
                if (R.next() < 0.35) {
                    const q = R.pick([ceilGrid(amount, d), ceilGrid(fixed(bn(amount).times(2)), d), unit(d),
                        String(R.int(1, 200))]);
                    h.deposit(R.pick(ACTORS), ADDR, TICK, q);
                }
                if (R.next() < 0.2) h.mineBlock(1);
                if (R.next() < 0.3) {
                    // Next round, sometimes after a gap; timestamps straddle T in no order.
                    const n = tip(h) + R.int(1, 3);
                    publish(h, { [n]: { ts: T + R.int(-1500, 1500), price: R.pick(PRICES) } });
                }
                const method = R.pick(WALK);
                const caller = R.pick(ACTORS);
                const before = { status: h.state(ADDR, 'status'), held: held(h), maker: bal(h, 'maker'),
                    taker: bal(h, 'taker'), stranger: bal(h, 'stranger'), tip: tip(h),
                    blockTs: h.ledger.blockTimestamp, acceptCursor: acceptCursor };
                const r = run(h, method, caller);
                const ctx = 'seed ' + seed + ' step ' + step + ' ' + method + ' by ' + caller;
                payouts += checkStep(h, ctx, method, caller, before, r);
                if (method === 'accept' && r.success) acceptCursor = before.tip;
                assert.strictEqual(h.ledger.total(TICK), supply, ctx + ': supply drift');
            }
            assert.ok(payouts <= 1, 'seed ' + seed + ': more than one terminal payout (' + payouts + ')');
        }
    });

    it('accept() refuses a match once the tip round already reaches settleTime (no free option)', function () {
        // Block time is still before T, but the tip round carries a timestamp at/after
        // T (the header's own clock-skew and non-monotonic-timestamp case), so the
        // round the scan starts at already decides the bet against the OVER maker.
        const h = setup({ side: 'OVER' });
        h.deposit('maker', ADDR, TICK, '100');
        assert.ok(run(h, 'fund', 'maker').success);
        publish(h, { 2: { ts: T + 10, price: '59000' } });
        assert.ok(h.ledger.blockTimestamp < T);
        h.deposit('taker', ADDR, TICK, '100');
        const r = run(h, 'accept', 'taker');
        assert.strictEqual(r.success, false,
            'taker matched a bet whose deciding round (2, price 59000 < strike) was already published');
        assert.ok(/settle round already published/.test(r.error), r.error);
        assert.strictEqual(h.state(ADDR, 'status'), 'OPEN');
        assert.ok(run(h, 'cancel', 'maker').success, 'the maker can still cancel');
    });

    it('a tip just before settleTime still matches, and the next round decides', function () {
        const h = setup({ side: 'OVER' });
        h.deposit('maker', ADDR, TICK, '100');
        run(h, 'fund', 'maker');
        publish(h, { 2: { ts: T - 1, price: '70000' } });
        h.deposit('taker', ADDR, TICK, '100');
        assert.ok(run(h, 'accept', 'taker').success);
        publish(h, { 3: { ts: T, price: '59000' } });
        const r = run(h, 'settle', 'stranger');
        assert.strictEqual(r.result, 'SETTLED');
        assert.strictEqual(h.state(ADDR, 'settledRound'), '3');
        assert.strictEqual(h.state(ADDR, 'winner'), 'taker');
    });

    it('lifecycle: every terminal status refuses every state-changing method', function () {
        const ends = {
            SETTLED: (h) => { publish(h, { 2: { ts: T + 1, price: '61000' } }); return run(h, 'settle', 'stranger'); },
            PUSH: (h) => { publish(h, { 2: { ts: T + 1, price: STRIKE } }); return run(h, 'settle', 'stranger'); },
            VOID: (h) => { h.mineBlock(3); return run(h, 'reclaim', 'taker'); }
        };
        for (const k of Object.keys(ends)) {
            const h = matchedBet();
            assert.ok(ends[k](h).success, k);
            assert.strictEqual(h.state(ADDR, 'status'), k);
            h.deposit('stranger', ADDR, TICK, '500');
            publish(h, { 9: { ts: T + 5, price: '61000' } });
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
            publish(h, { 2: { ts: T, price: '61000' } });
            assert.strictEqual(run(h, 'settle', c).result, 'SETTLED', 'settle is permissionless: ' + c);
        }
    });

    it('accept honours the settleTime boundary exactly', function () {
        const h = setup({ settleTime: T0 + 1200 });
        h.deposit('maker', ADDR, TICK, '100');
        run(h, 'fund', 'maker');
        h.deposit('taker', ADDR, TICK, '100');
        h.mineBlock(2);   // block time == settleTime
        assert.ok(!run(h, 'accept', 'taker').success, 'accept at settleTime');
        const g = setup({ settleTime: T0 + 1201 });
        g.deposit('maker', ADDR, TICK, '100');
        run(g, 'fund', 'maker');
        g.deposit('taker', ADDR, TICK, '100');
        g.mineBlock(2);   // one second before settleTime
        assert.ok(run(g, 'accept', 'taker').success, 'accept one second early');
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

    it('huge stake: a 31-digit stake pushes and voids exactly', function () {
        const big = '1234567890123456789012345678901';
        const h = matchedBet({ amount: big });
        publish(h, { 2: { ts: T, price: STRIKE } });
        assert.strictEqual(run(h, 'settle', 'stranger').result, 'PUSH');
        assert.strictEqual(bal(h, 'maker'), FUNDS);
        assert.strictEqual(bal(h, 'taker'), FUNDS);
        const v = matchedBet({ amount: big });
        v.mineBlock(3);
        assert.ok(run(v, 'reclaim', 'maker').success);
        assert.strictEqual(bal(v, 'maker'), FUNDS);
    });

    it('a 450-round pre-deadline backlog pages through SCANNING and settles on the first qualifying round', function () {
        const h = matchedBet();
        const spec = {};
        for (let n = 2; n <= 450; n++) spec[n] = { ts: T - 2000 + n, price: '59000' };
        spec[451] = { ts: T + 3, price: '61000' };
        spec[452] = { ts: T + 9, price: '1' };
        publish(h, spec);
        h.mineBlock(3);
        assert.ok(!run(h, 'reclaim', 'maker').success, 'reclaim refuses an incomplete or decided span');
        const out = [];
        for (let i = 0; i < 5 && h.state(ADDR, 'status') === 'MATCHED'; i++) out.push(run(h, 'settle', 'stranger').result);
        assert.deepStrictEqual(out, ['SCANNING', 'SCANNING', 'SETTLED']);
        assert.strictEqual(h.state(ADDR, 'settledRound'), '451');
        assert.strictEqual(bal(h, 'maker'), fixed(bn(FUNDS).plus(100)));
    });

    it('constructor boundaries: zero, non-plain, past and out-of-range terms revert', function () {
        const bad = [{ amount: '0' }, { amount: '1e2' }, { settleTime: T0 }, { settleTime: 253402300800 },
            { settleTime: '1.7e9' }, { window: 0 }, { window: 1000001 }];
        for (const b of bad) assert.ok(!setup(b).deployResult.success, JSON.stringify(b));
        assert.ok(setup({ settleTime: 253402300799, window: 1000000 }).deployResult.success);
    });

    it('determinism: the template never touches Date or Math.random on any path', function () {
        const h = matchedBet();
        publish(h, { 2: { ts: T, price: '61000' } });
        const r = run(h, 'settle', 'stranger');
        assert.strictEqual(r.result, 'SETTLED', r.error);
        assert.doesNotMatch(CODE, /Date\.|Math\.random|for\s*\(\s*var\s+\w+\s+in\b/);
    });

    // NOTE (limitation, not a finding): the PENDING path parks the cursor one past
    // the pair's tip. If the pair then stalls while the global preload floor moves
    // past that cursor, the next round the pair publishes sits above an evicted
    // span the contract cannot tell apart from rounds it never saw, so settle()
    // and reclaim() both refuse. The header says a bet settled on before its
    // deadline "can never be overtaken by the window"; under the floor model above
    // a stalled pair is the exception. Depends on the floor semantics noted at the
    // top of this file.
    it('NOTE: a pair stall past the floor after PENDING leaves no exit (characterises current behaviour)', function () {
        const h = matchedBet();
        publish(h, { 2: { ts: T - 100, price: '59000' } });
        assert.strictEqual(run(h, 'settle', 'stranger').result, 'PENDING');
        assert.strictEqual(h.state(ADDR, 'cursor'), '3');
        h.roundFloor = 10;
        publish(h, { 12: { ts: T + 10, price: '61000' } });
        h.mineBlock(3);
        assert.ok(/outside the retrievable oracle window/.test(run(h, 'settle', 'stranger').error));
        assert.ok(/outside the retrievable oracle window/.test(run(h, 'reclaim', 'maker').error));
        assert.strictEqual(held(h), '200');
    });
});
