// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// vesting_test/invariants.js: seeded invariant tests for vesting.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Harness assumption: getTokenInfo(tick) returns DECIMALS once the contract holds a
// balance entry for the tick, which fund() and every later payout path rely on.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, bn, fixed, M } = require('../../test/helpers/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'vesting.js'), 'utf8');
const ADDR = 'C:BTC:9';
const TICK = 'VEST';
const ACTORS = ['grantor', 'bene', 'stranger'];

// The shared harness builds its tolerance band with mathjs max(), which is itself
// tolerance-aware: near zero it returns 1e-12 x larger instead of the 1e-15 floor,
// so sub-1e-15 values compare as distinct. This wrapper applies the documented band,
// max(1e-12 x larger, 1e-15), using exact Decimal comparisons.
function documentedCompare(a, b) {
    const x = bn(a), y = bn(b);
    const larger = x.abs().gt(y.abs()) ? x.abs() : y.abs();
    let band = larger.times('1e-12');
    if (band.lt(bn('1e-15'))) band = bn('1e-15');
    if (x.minus(y).abs().lte(band)) return 0;
    return x.gt(y) ? 1 : -1;
}

function withDocumentedTolerance(api) {
    const c = documentedCompare;
    Object.assign(api.math, {
        gt: (a, b) => c(a, b) > 0, gte: (a, b) => c(a, b) >= 0, lt: (a, b) => c(a, b) < 0,
        lte: (a, b) => c(a, b) <= 0, eq: (a, b) => c(a, b) === 0, compare: c
    });
    return api;
}

class TolHarness extends Harness {
    makeApi(addr, params, caller, actions) { return withDocumentedTolerance(super.makeApi(addr, params, caller, actions)); }
}

function setup(o) {
    const h = new TolHarness();
    h.ledger.setTokenDecimals(TICK, o.decimals);
    h.seedBalance('grantor', TICK, o.supply || '1000000000');
    const r = h.deploy({ code: CODE, deployer: 'grantor', contractAddress: ADDR,
        params: ['grantor', 'bene', TICK, o.total, String(o.cliff), String(o.duration), o.revocable ? 'true' : 'false'] });
    assert.ok(r.success, r.error);
    return h;
}

function call(h, method, caller) {
    return h.execute({ contractAddress: ADDR, method: method, params: [], caller: caller });
}

function floorGrid(v, d) { return bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_DOWN); }

// Exact model of the vested amount at the current height, before any revoke.
function modelVested(h, total) {
    const start = parseInt(h.state(ADDR, 'start'), 10);
    const elapsed = h.ledger.blockHeight - start;
    if (elapsed < parseInt(h.state(ADDR, 'cliff'), 10)) return bn(0);
    const duration = parseInt(h.state(ADDR, 'duration'), 10);
    if (elapsed >= duration) return bn(total);
    return bn(total).times(elapsed).div(duration);
}

const CONFIGS = [
    { decimals: 0, total: '7', cliff: 0, duration: 3 },
    { decimals: 0, total: '1000', cliff: 2, duration: 9 },
    { decimals: 2, total: '1000.01', cliff: 1, duration: 7 },
    { decimals: 8, total: '1000.5', cliff: 0, duration: 13 },
    { decimals: 8, total: '0.00000003', cliff: 0, duration: 7 },
    { decimals: 18, total: '0.000000000000013', cliff: 0, duration: 6 }
];

// One seeded run: random calls from random actors, checking custody and accounting each step.
function runSeed(seed, stats) {
    const R = rng(seed);
    const cfg = Object.assign({ revocable: R.next() < 0.6 }, R.pick(CONFIGS));
    const h = setup(cfg);
    const supply = h.ledger.total(TICK);
    const tot = cfg.total;
    let surplus = bn(0);
    let beneGot = bn(0);
    let revokedPaid = bn(0);
    h.deposit('grantor', ADDR, TICK, tot);
    if (R.next() < 0.2) { h.deposit('grantor', ADDR, TICK, '1'); surplus = surplus.plus(1); }
    for (let step = 0; step < 25; step++) {
        if (R.next() < 0.35) h.mineBlock(R.int(1, 3));
        const m = R.next() < 0.03 ? 'cancel' : R.pick(['fund', 'fund', 'claim', 'claim', 'claim', 'revoke', 'info']);
        const who = R.pick(ACTORS);
        const st0 = h.state(ADDR, 'status');
        const vested0 = st0 === 'ACTIVE' ? modelVested(h, h.state(ADDR, 'total')) : null;
        const claimed0 = bn(h.state(ADDR, 'claimed'));
        const r = call(h, m, who);
        assert.strictEqual(h.ledger.total(TICK), supply, 'seed ' + seed + ' supply drift');
        if (!r.success) continue;
        stats[m] = (stats[m] || 0) + 1;
        const sends = r.actions.filter((a) => a.action === 'SEND');
        if (m === 'claim') {
            assert.strictEqual(who, 'bene', 'seed ' + seed + ' claim by ' + who);
            const q = bn(sends[0].settled);
            assert.ok(bn(sends[0].params.quantity).eq(q), 'seed ' + seed + ' emitted amount re-rounded by the ledger');
            if (vested0) assert.ok(q.eq(floorGrid(vested0, cfg.decimals).minus(claimed0)), 'seed ' + seed + ' claim != floor(vested) - claimed');
            beneGot = beneGot.plus(q);
        } else if (m === 'revoke') {
            assert.strictEqual(who, 'grantor');
            assert.ok(cfg.revocable, 'seed ' + seed + ' revoked a non-revocable grant');
            revokedPaid = bn(sends[0].settled);
            assert.ok(revokedPaid.eq(floorGrid(bn(tot).minus(vested0), cfg.decimals)), 'seed ' + seed + ' revoke amount');
        } else if (m === 'cancel') {
            assert.strictEqual(st0, 'INIT');
            assert.strictEqual(who, 'grantor');
        } else if (m === 'fund') {
            assert.strictEqual(who, 'grantor', 'seed ' + seed + ' fund by ' + who);
        }
        const st = h.state(ADDR, 'status');
        if (st === 'ACTIVE' || st === 'REVOKED') {
            assert.ok(bn(h.state(ADDR, 'claimed')).eq(beneGot), 'seed ' + seed + ' claimed != received');
            const custody = bn(h.ledger.getBalance(ADDR, TICK));
            assert.ok(custody.eq(bn(h.state(ADDR, 'total')).minus(beneGot).plus(surplus)),
                'seed ' + seed + ' custody ' + custody.toFixed() + ' != total - claimed + surplus');
        }
    }
    // Drain: whatever state the run ended in, the grant and its reclaim sum to total.
    const st = h.state(ADDR, 'status');
    if (st === 'ACTIVE' || st === 'REVOKED') {
        h.mineBlock(cfg.duration + 1);
        const r = call(h, 'claim', 'bene');
        if (r.success) beneGot = beneGot.plus(bn(r.actions[0].settled));
        assert.ok(beneGot.plus(revokedPaid).eq(bn(tot)), 'seed ' + seed + ' payouts do not sum to total');
        assert.ok(bn(h.ledger.getBalance(ADDR, TICK)).eq(surplus), 'seed ' + seed + ' custody not drained to surplus');
    }
}

(available ? describe : describe.skip)('vesting invariants (in-process)', function () {
    it('conservation, accounting and exact drain across seeded random sequences', function () {
        const stats = {};
        for (let seed = 1; seed <= 300; seed++) runSeed(seed, stats);
        assert.ok(stats.claim > 200 && stats.revoke > 30 && stats.cancel > 5, 'coverage ' + JSON.stringify(stats));
    });

    it('authorization: each entry point accepts only its documented caller', function () {
        const expect = { fund: ['grantor'], cancel: ['grantor'], claim: ['bene'], revoke: ['grantor'] };
        for (const m of Object.keys(expect)) for (const who of ACTORS) {
            const h = setup({ decimals: 8, total: '100', cliff: 0, duration: 10, revocable: true });
            h.deposit('grantor', ADDR, TICK, '100');
            if (m !== 'fund' && m !== 'cancel') { assert.ok(call(h, 'fund', 'grantor').success); h.mineBlock(5); }
            assert.strictEqual(call(h, m, who).success, expect[m].indexOf(who) >= 0, m + ' by ' + who);
        }
    });

    it('lifecycle: no claim before fund, no double fund, revoke once, cancel only while INIT', function () {
        const h = setup({ decimals: 8, total: '100', cliff: 2, duration: 10, revocable: true });
        assert.ok(!call(h, 'claim', 'bene').success, 'claim before fund');
        assert.ok(!call(h, 'revoke', 'grantor').success, 'revoke before fund');
        h.deposit('grantor', ADDR, TICK, '100');
        assert.ok(call(h, 'fund', 'grantor').success);
        assert.ok(!call(h, 'fund', 'grantor').success, 'second fund');
        assert.ok(!call(h, 'cancel', 'grantor').success, 'cancel after fund');
        h.mineBlock(1);
        assert.ok(!call(h, 'claim', 'bene').success, 'claim inside cliff');
        h.mineBlock(3);
        const c1 = call(h, 'claim', 'bene');
        assert.strictEqual(c1.result, '40');
        assert.ok(!call(h, 'claim', 'bene').success, 'second claim in the same block');
        const rv = call(h, 'revoke', 'grantor');
        assert.strictEqual(rv.result, '60');
        assert.ok(!call(h, 'revoke', 'grantor').success, 'second revoke');
        h.mineBlock(20);
        assert.ok(!call(h, 'claim', 'bene').success, 'nothing accrues after revoke');
        assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '0');
    });

    it('boundaries: one base unit grants, a large total, and cliff == duration', function () {
        let h = setup({ decimals: 8, total: '0.00000001', cliff: 0, duration: 1000000, revocable: true });
        h.deposit('grantor', ADDR, TICK, '0.00000001');
        assert.ok(call(h, 'fund', 'grantor').success);
        h.mineBlock(999999);
        assert.ok(!call(h, 'claim', 'bene').success, 'sub-grid accrual is not paid');
        assert.ok(!call(h, 'revoke', 'grantor').success, 'unvested floors to zero: nothing to revoke');
        h.mineBlock(1);
        assert.strictEqual(call(h, 'claim', 'bene').result, '0.00000001');

        h = setup({ decimals: 8, total: '92233720368.54775807', supply: '92233720368.54775807', cliff: 0, duration: 7, revocable: false });
        h.deposit('grantor', ADDR, TICK, '92233720368.54775806');
        assert.ok(!call(h, 'fund', 'grantor').success, 'one base unit short');
        h.deposit('grantor', ADDR, TICK, '0.00000001');
        assert.ok(call(h, 'fund', 'grantor').success);
        let got = bn(0);
        for (let i = 0; i < 8; i++) {
            h.mineBlock(1);
            const r = call(h, 'claim', 'bene');
            if (r.success) got = got.plus(bn(r.actions[0].settled));
        }
        assert.strictEqual(fixed(got), '92233720368.54775807');
        assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '0');

        h = setup({ decimals: 0, total: '5', cliff: 4, duration: 4, revocable: false });
        h.deposit('grantor', ADDR, TICK, '5');
        assert.ok(call(h, 'fund', 'grantor').success);
        h.mineBlock(3);
        assert.ok(!call(h, 'claim', 'bene').success);
        h.mineBlock(1);
        assert.strictEqual(call(h, 'claim', 'bene').result, '5');
    });

    it('constructor boundaries revert', function () {
        const bad = [['0', '0', '1'], ['1e2', '0', '1'], ['Infinity', '0', '1'], ['-1', '0', '1'],
            ['10', '2', '1'], ['10', '0', '0'], ['10', '0', '1000001'], ['10', '1e1', '20'], ['10', '-1', '5']];
        for (const p of bad) {
            const h = new TolHarness();
            const r = h.deploy({ code: CODE, deployer: 'grantor', contractAddress: ADDR,
                params: ['grantor', 'bene', TICK, p[0], p[1], p[2], 'true'] });
            assert.ok(!r.success, p.join(','));
        }
        const h = new TolHarness();
        assert.ok(!h.deploy({ code: CODE, deployer: 'grantor', contractAddress: ADDR,
            params: ['grantor', 'bene', TICK, '10', '0', '5', 'yes'] }).success, 'revocable flag');
        // NOTE: initialize() checks total with the tolerant gt, so a positive total inside
        // the 1e-15 band (here 13 base units of an 18-decimal tick) is refused at deploy.
        const t = new TolHarness();
        assert.ok(!t.deploy({ code: CODE, deployer: 'grantor', contractAddress: ADDR,
            params: ['grantor', 'bene', TICK, '0.000000000000000013', '0', '5', 'true'] }).success, 'sub-1e-15 total');
    });
});
