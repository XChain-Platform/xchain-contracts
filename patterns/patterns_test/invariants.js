// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// patterns_test/invariants.js: seeded invariant tests for the pattern helpers on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The helper files are read verbatim and pasted above a small test contract (the
// documented authoring model), which then runs on the in-process harness. Each
// helper is checked against an independent reference model over seeded inputs,
// and a composed owner / pause / status / custody contract is driven through
// random call sequences.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, bn } = require('../../test/inproc/harness.js');

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

const DIR = path.join(__dirname, '..');
const HELPERS = ['access-control.js', 'pausable.js', 'state-machine.js', 'validation.js', 'safe-transfer.js']
    .map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n');

// A probe contract: every method calls exactly one helper with its params.
const PROBE = HELPERS + `
module.exports = {
    meta: { name: 'Pattern Probe', description: 'Test-only probe for the pattern helpers.', version: '0.0.0' },
    initialize: function (xchain) {
        xchain.state.set('owner', xchain.getInputParam(0));
        xchain.state.set('arbiter', xchain.getInputParam(1));
        xchain.state.set('payee', xchain.getInputParam(2));
        xchain.state.set('tick', xchain.getInputParam(3));
        setStatus(xchain, 'OPEN');
    },
    ownerOnly: function (xchain) { onlyOwner(xchain); return 'ok'; },
    ownerView: function (xchain) { return isOwner(xchain); },
    roleOnly:  function (xchain) { onlyRole(xchain, xchain.getInputParam(0)); return 'ok'; },
    pause:     function (xchain) { onlyOwner(xchain); setPaused(xchain, true); },
    unpause:   function (xchain) { onlyOwner(xchain); setPaused(xchain, false); },
    pausedView: function (xchain) { return isPaused(xchain); },
    status:    function (xchain) { requireStatus(xchain, xchain.getInputParam(0)); return 'ok'; },
    statusIn:  function (xchain) { requireStatusIn(xchain, xchain.getInputParam(0).split(',')); return 'ok'; },
    vAddress:  function (xchain) { requireAddress(xchain, xchain.getInputParam(0), 'v'); return 'ok'; },
    vPositive: function (xchain) { requirePositive(xchain, xchain.getInputParam(0), 'v'); return 'ok'; },
    vPlain:    function (xchain) { requirePlainDecimal(xchain, xchain.getInputParam(0), 'v'); return 'ok'; },
    vEnum:     function (xchain) { requireEnum(xchain, xchain.getInputParam(0), xchain.getInputParam(1).split(','), 'v'); return 'ok'; },
    vInt:      function (xchain) {
        requireIntInRange(xchain, xchain.getInputParam(0), parseInt(xchain.getInputParam(1), 10), parseInt(xchain.getInputParam(2), 10), 'v');
        return 'ok';
    },
    atLeast:   function (xchain) { return isAtLeastExact(xchain, xchain.getInputParam(0), xchain.getInputParam(1)); },
    held:      function (xchain) { return heldBalance(xchain, xchain.getInputParam(0)); },
    needHeld:  function (xchain) { requireHeld(xchain, xchain.getInputParam(0), xchain.getInputParam(1)); return 'ok'; },
    since:     function (xchain) { return depositedSince(xchain, xchain.getInputParam(0), xchain.getInputParam(1)); },
    // The safe-transfer.js header example, guarded by the other patterns.
    payout: function (xchain) {
        whenNotPaused(xchain);
        requireStatus(xchain, 'OPEN');
        var tick   = xchain.state.get('tick');
        var amount = heldBalance(xchain, tick);
        xchain.require(!isAtLeastExact(xchain, '0', amount), 'nothing to pay out');
        setStatus(xchain, 'PAID');
        xchain.emit.send({ destination: xchain.state.get('payee'), tick: tick, quantity: amount });
    }
};
`;

const ADDR = 'C:BTC:3';
const TICK = 'PT';
const ACTORS = ['owner', 'arbiter', 'payee', 'stranger'];

function setup() {
    const h = new TolHarness();
    h.seedBalance('stranger', TICK, '1000');
    const r = h.deploy({ code: PROBE, deployer: 'owner', contractAddress: ADDR, params: ['owner', 'arbiter', 'payee', TICK] });
    assert.ok(r.success, r.error);
    return h;
}

function ok(h, method, params, caller) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller || 'stranger' }).success;
}

function val(h, method, params, caller) {
    const r = h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller || 'stranger' });
    assert.ok(r.success, method + ': ' + r.error);
    return r.result;
}

// Reference models (independent of the helper code).
const INT_RE = /^-?[0-9]+$/;
const PLAIN_RE = /^[0-9]+(\.[0-9]+)?$/;

const ALPHABET = ['0', '1', '5', '9', '.', '-', '+', 'e', 'x', ' ', '_', 'a'];
function randomText(R) {
    let s = '';
    const n = R.int(0, 7);
    for (let i = 0; i < n; i++) s += R.pick(ALPHABET);
    return s;
}

function randomDecimal(R) {
    const scale = R.pick([0, 2, 8, 18]);
    let digits = String(R.int(0, 999999));
    if (R.next() < 0.3) digits += '000000000000';
    if (scale === 0) return digits;
    let frac = '';
    for (let i = 0; i < scale; i++) frac += String(R.int(0, 9));
    return digits + '.' + frac;
}

(available ? describe : describe.skip)('pattern helper invariants (in-process)', function () {
    it('isAtLeastExact agrees with exact comparison, including sub-tolerance gaps', function () {
        const h = setup();
        const R = rng(11);
        for (let i = 0; i < 400; i++) {
            const a = randomDecimal(R);
            let b;
            const k = R.int(0, 3);
            if (k === 0) b = randomDecimal(R);
            else if (k === 1) b = a;
            else b = bn(a).plus(bn(R.pick(['1e-18', '1e-8', '-1e-18', '-1e-8']))).toFixed();
            const expect = bn(a).gte(bn(b));
            assert.strictEqual(val(h, 'atLeast', [a, b]), expect, a + ' >= ' + b);
        }
        // Spelling-equal values, signed zero and the documented fail-closed cases.
        assert.strictEqual(val(h, 'atLeast', ['1.000', '1']), true);
        assert.strictEqual(val(h, 'atLeast', ['0', '-0']), true);
        assert.strictEqual(val(h, 'atLeast', ['999999.99999999', '1000000']), false);
        assert.strictEqual(val(h, 'atLeast', ['NaN', '1']), false);
        assert.strictEqual(val(h, 'atLeast', ['Infinity', '1']), false, 'non-finite difference fails closed (documented)');
    });

    it('requireIntInRange accepts exactly canonical integer text inside the range', function () {
        const h = setup();
        const R = rng(12);
        for (let i = 0; i < 600; i++) {
            const v = R.next() < 0.5 ? String(R.int(-20, 1200000)) : randomText(R);
            const min = R.pick(['0', '1', '-5']);
            const max = R.pick(['10', '1000000']);
            const expect = INT_RE.test(v) && parseInt(v, 10) >= parseInt(min, 10) && parseInt(v, 10) <= parseInt(max, 10);
            assert.strictEqual(ok(h, 'vInt', [v, min, max]), expect, JSON.stringify(v) + ' in [' + min + ',' + max + ']');
        }
        for (const v of ['1e3', '0x10', ' 7', '7 ', '5.99', '+7', '', '-', '9007199254740993', '1'.repeat(400)])
            assert.ok(!ok(h, 'vInt', [v, '0', '1000000']), JSON.stringify(v));
        assert.ok(ok(h, 'vInt', ['1000000', '1', '1000000']));
        assert.ok(ok(h, 'vInt', ['007', '1', '10']), 'leading zeros are base-10 integer text (note)');
    });

    it('requirePlainDecimal accepts exactly digits with one interior point', function () {
        const h = setup();
        const R = rng(13);
        for (let i = 0; i < 600; i++) {
            const v = R.next() < 0.3 ? randomDecimal(R) : randomText(R);
            assert.strictEqual(ok(h, 'vPlain', [v]), PLAIN_RE.test(v), JSON.stringify(v));
        }
    });

    it('requirePositive, requireAddress and requireEnum', function () {
        const h = setup();
        for (const v of ['1', '0.00000001', '0.000000000000002', '1000000000000']) assert.ok(ok(h, 'vPositive', [v]), v);
        for (const v of ['0', '-1', '-0.00000001', '0.000']) assert.ok(!ok(h, 'vPositive', [v]), v);
        // Documented tolerance: README says the tolerant gt is fine for a positivity check
        // against '0', so a positive value under 1e-15 reads as non-positive (fails closed).
        for (const v of ['0.000000000000001', '0.0000000000000001'])
            assert.ok(!ok(h, 'vPositive', [v]), v + ' is inside the 1e-15 band (documented tolerance)');
        assert.ok(ok(h, 'vAddress', ['bc1q']));
        assert.ok(!ok(h, 'vAddress', ['']));
        assert.ok(!ok(h, 'vAddress', []));
        assert.ok(ok(h, 'vEnum', ['b', 'a,b,c']));
        for (const v of ['', 'B', 'a,b', ' b']) assert.ok(!ok(h, 'vEnum', [v, 'a,b,c']), JSON.stringify(v));
    });

    it('access control and state machine accept exactly the stored caller / status', function () {
        const h = setup();
        for (const c of ACTORS) {
            assert.strictEqual(ok(h, 'ownerOnly', [], c), c === 'owner', 'onlyOwner ' + c);
            assert.strictEqual(val(h, 'ownerView', [], c), c === 'owner', 'isOwner ' + c);
            for (const role of ['arbiter', 'payee', 'missingRole'])
                assert.strictEqual(ok(h, 'roleOnly', [role], c), c === role, 'onlyRole ' + role + ' by ' + c);
        }
        assert.ok(ok(h, 'status', ['OPEN']));
        assert.ok(!ok(h, 'status', ['open']));
        assert.ok(ok(h, 'statusIn', ['PAID,OPEN']));
        assert.ok(!ok(h, 'statusIn', ['PAID,CLOSED']));
    });

    it('safe-transfer reads custody exactly', function () {
        const h = setup();
        assert.strictEqual(val(h, 'held', ['NONE']), '0');
        h.seedBalance('stranger', TICK, '1000000');
        h.deposit('stranger', ADDR, TICK, '999999.99999999');
        assert.strictEqual(val(h, 'held', [TICK]), '999999.99999999');
        assert.ok(!ok(h, 'needHeld', [TICK, '1000000']), 'one base unit short of 1e6');
        assert.ok(ok(h, 'needHeld', [TICK, '999999.99999999']));
        assert.strictEqual(val(h, 'since', [TICK, '999999.99999998']), '0.00000001');
        assert.strictEqual(val(h, 'since', [TICK, null]), '999999.99999999');
    });

    it('composed contract: conservation, single payout, pause and owner gates under seeded random calls', function () {
        let payoutsSeen = 0;
        for (let seed = 1; seed <= 150; seed++) {
            const R = rng(seed);
            const h = setup();
            let payouts = 0;
            for (let step = 0; step < 25; step++) {
                if (R.next() < 0.3) h.deposit('stranger', ADDR, TICK, String(R.int(1, 20)));
                const m = R.pick(['pause', 'unpause', 'payout', 'payout']);
                const c = R.pick(ACTORS);
                const pausedBefore = h.state(ADDR, 'paused') === 'true';
                const held = h.ledger.getBalance(ADDR, TICK);
                const r = h.execute({ contractAddress: ADDR, method: m, params: [], caller: c });
                assert.strictEqual(h.ledger.total(TICK), '1000', 'seed ' + seed + ' supply drift');
                if (m === 'pause' || m === 'unpause') {
                    assert.strictEqual(r.success, c === 'owner', 'seed ' + seed + ' ' + m + ' by ' + c);
                    if (r.success) assert.strictEqual(h.state(ADDR, 'paused'), m === 'pause' ? 'true' : 'false');
                } else if (r.success) {
                    payouts++;
                    assert.ok(!pausedBefore, 'seed ' + seed + ' payout while paused');
                    assert.strictEqual(r.actions[0].settled, held);
                    assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '0');
                }
            }
            assert.ok(payouts <= 1, 'seed ' + seed + ' paid out ' + payouts + ' times');
            payoutsSeen += payouts;
        }
        assert.ok(payoutsSeen > 50, 'coverage: ' + payoutsSeen + ' payouts');
    });
});
