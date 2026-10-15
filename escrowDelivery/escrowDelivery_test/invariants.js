// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// escrowDelivery_test/invariants.js: seeded invariant tests for escrowDelivery.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The shared harness does not model xchain.attestation, so AttestHarness below
// adds it: request() records an ATTEST action and returns a deterministic id,
// getResponse() reads a response seeded the way the indexer anchors one, and
// ATTEST actions are skipped at apply time (they move no tokens). The id format
// is a harness assumption; the contract only compares it for equality.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, bn } = require('../../test/inproc/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'escrowDelivery.js'), 'utf8');
const ADDR = 'C:BTC:1';
const TICK = 'TEST';
const MARKER = '"status":"delivered"';
const URL = 'https://carrier.example.com/track/1Z999';
const ACTORS = ['buyer', 'seller', 'arbiter', 'stranger'];
const TERMINAL = ['DELIVERED', 'RELEASED', 'REFUNDED', 'CANCELLED'];
const PAYEE = { DELIVERED: 'seller', RELEASED: 'seller', REFUNDED: 'buyer', CANCELLED: 'buyer' };

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

class AttestHarness extends Harness {
    constructor() {
        super();
        this.responses = {};
        this.requestSeq = 0;
    }
    makeApi(addr, params, caller, actions) {
        const api = withDocumentedTolerance(super.makeApi(addr, params, caller, actions));
        const self = this;
        api.attestation = {
            request: function (providerId, payload, callbackMethod, context, options) {
                self.requestSeq += 1;
                const id = 'req-' + self.ledger.blockHeight + '-' + self.requestSeq;
                actions.push({ action: 'ATTEST', params: { providerId: providerId, requestPayload: payload,
                    callbackMethod: callbackMethod, context: context, options: options, requestId: id } });
                return id;
            },
            getResponse: function (id) {
                return self.responses[id] === undefined ? null : JSON.parse(JSON.stringify(self.responses[id]));
            }
        };
        return api;
    }
    applyActions(addr, actions) {
        super.applyActions(addr, actions.filter((a) => a.action !== 'ATTEST'));
    }
    seedResponse(id, payload, status) {
        this.responses[id] = { status: status === undefined ? 'ok' : status, payload: payload, providerId: 'http_get', validatorCount: 3 };
    }
}

function setup(amount, window, buyerFunds) {
    const h = new AttestHarness();
    h.seedBalance('buyer', TICK, buyerFunds || '1000');
    const r = h.deploy({ code: CODE, deployer: 'buyer', contractAddress: ADDR,
        params: ['buyer', 'seller', 'arbiter', TICK, amount || '200', String(window || 3), MARKER] });
    assert.ok(r.success, r.error);
    return h;
}

function call(h, method, caller, params) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller });
}

function funded(amount, window) {
    const h = setup(amount, window);
    h.deposit('buyer', ADDR, TICK, amount || '200');
    assert.ok(call(h, 'fund', 'buyer').success);
    return h;
}

const BODIES = [
    () => ['tracking...\n' + MARKER + '\n', 'ok'],
    () => ['label created, awaiting pickup', 'ok'],
    () => ['', 'failed'],
    () => [MARKER, 'timeout']
];

// One random step: a deposit, some blocks, then one contract call.
function randomStep(h, R, ids) {
    const spare = parseInt(h.ledger.getBalance('buyer', TICK), 10);
    if (R.next() < 0.25 && spare >= 1) h.deposit('buyer', ADDR, TICK, String(R.int(1, Math.min(150, spare))));
    if (R.next() < 0.2) h.mineBlock(R.int(1, 3));
    const caller = R.pick(ACTORS);
    const m = R.pick(['fund', 'requestDelivery', 'onDelivery', 'onDelivery', 'release', 'refund', 'timeout', 'cancel']);
    if (m === 'requestDelivery') {
        const r = call(h, m, caller, [URL]);
        if (r.success) ids.push(r.result);
        return { m: m, r: r };
    }
    if (m === 'onDelivery') {
        const id = ids.length && R.next() < 0.85 ? R.pick(ids) : 'forged-' + R.int(1, 9);
        if (R.next() < 0.7 && h.responses[id] === undefined) {
            const b = R.pick(BODIES)();
            h.seedResponse(id, b[0], b[1]);
        }
        return { m: m, r: call(h, m, caller, [id]), id: id };
    }
    return { m: m, r: call(h, m, caller) };
}

(available ? describe : describe.skip)('escrowDelivery invariants (in-process)', function () {
    it('conservation, single settlement and absorbing terminal status across seeded random sequences', function () {
        for (let seed = 1; seed <= 200; seed++) {
            const R = rng(seed);
            const h = setup();
            const ids = [];
            let payouts = 0;
            let terminal = null;
            for (let step = 0; step < 30; step++) {
                const before = h.state(ADDR, 'status');
                const s = randomStep(h, R, ids);
                const sends = s.r.success ? s.r.actions.filter((a) => a.action === 'SEND') : [];
                payouts += sends.length;
                const after = h.state(ADDR, 'status');
                assert.strictEqual(h.ledger.total(TICK), '1000', 'seed ' + seed + ' supply drift');
                if (terminal) assert.strictEqual(after, terminal, 'seed ' + seed + ' terminal status changed');
                if (sends.length) {
                    assert.ok(TERMINAL.indexOf(after) >= 0, 'seed ' + seed + ' payout without terminal status');
                    assert.strictEqual(sends[0].params.destination, PAYEE[after], 'seed ' + seed + ' wrong payee');
                    assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '0', 'seed ' + seed + ' payout left custody');
                    assert.ok(before === 'FUNDED' || (before === 'INIT' && after === 'CANCELLED'),
                        'seed ' + seed + ' settled from ' + before);
                    if (s.m === 'onDelivery') {
                        const resp = h.responses[s.id];
                        assert.ok(resp && resp.status === 'ok' && resp.payload.indexOf(MARKER) >= 0,
                            'seed ' + seed + ' onDelivery paid without a matching attested body');
                    }
                }
                if (TERMINAL.indexOf(after) >= 0) terminal = after;
            }
            assert.ok(payouts <= 1, 'seed ' + seed + ': more than one payout (' + payouts + ')');
        }
    });

    it('authorization: manual settlement paths accept exactly the documented roles', function () {
        const allowed = { release: ['buyer', 'arbiter'], refund: ['seller', 'arbiter'], timeout: ['buyer'] };
        for (const m of Object.keys(allowed)) for (const c of ACTORS) {
            const h = funded('200', 1);
            h.mineBlock(1);
            assert.strictEqual(call(h, m, c).success, allowed[m].indexOf(c) >= 0, m + ' by ' + c);
        }
        for (const c of ACTORS) {
            const h = setup();
            h.deposit('buyer', ADDR, TICK, '5');
            assert.strictEqual(call(h, 'cancel', c).success, c === 'buyer', 'cancel by ' + c);
        }
    });

    it('onDelivery: only the outstanding request settles; a cleared request cannot be replayed later', function () {
        const h = funded();
        const first = call(h, 'requestDelivery', 'stranger', [URL]).result;
        h.seedResponse(first, 'in transit', 'ok');
        assert.ok(call(h, 'onDelivery', 'stranger', [first]).success);
        assert.strictEqual(h.state(ADDR, 'pending'), null);
        const second = call(h, 'requestDelivery', 'stranger', [URL]).result;
        assert.notStrictEqual(first, second);
        // The first response is rewritten to a match; replaying it must not settle.
        h.seedResponse(first, MARKER, 'ok');
        const replay = call(h, 'onDelivery', 'stranger', [first]);
        assert.ok(!replay.success && /outstanding/.test(replay.error), replay.error);
        assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '200');
        h.seedResponse(second, 'x' + MARKER + 'y', 'ok');
        const ok = call(h, 'onDelivery', 'stranger', [second]);
        assert.ok(ok.success);
        assert.strictEqual(ok.result, 'delivered');
        assert.strictEqual(h.ledger.getBalance('seller', TICK), '200');
        assert.ok(!call(h, 'onDelivery', 'stranger', [second]).success, 'second callback for the same id');
    });

    it('onDelivery with no id while nothing is pending moves nothing', function () {
        const h = funded();
        const r = call(h, 'onDelivery', 'stranger', []);
        assert.ok(!r.success && /no response yet/.test(r.error), r.error);
        assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '200');
    });

    it('a status other than ok never pays, even when the payload carries the marker', function () {
        for (const st of ['failed', 'timeout', 'OK', '']) {
            const h = funded();
            const id = call(h, 'requestDelivery', 'buyer', [URL]).result;
            h.seedResponse(id, MARKER, st);
            const r = call(h, 'onDelivery', 'buyer', [id]);
            assert.ok(r.success && r.actions.length === 0, 'status ' + JSON.stringify(st));
            assert.strictEqual(h.state(ADDR, 'status'), 'FUNDED');
        }
    });

    it('lifecycle: requestDelivery needs FUNDED and no pending check; settlement is single-shot', function () {
        const h = setup();
        assert.ok(!call(h, 'requestDelivery', 'buyer', [URL]).success, 'before fund');
        h.deposit('buyer', ADDR, TICK, '200');
        assert.ok(call(h, 'fund', 'buyer').success);
        assert.ok(!call(h, 'fund', 'buyer').success, 'second fund');
        assert.ok(!call(h, 'requestDelivery', 'buyer', ['']).success, 'empty url');
        assert.ok(call(h, 'requestDelivery', 'buyer', [URL]).success);
        assert.ok(!call(h, 'requestDelivery', 'seller', [URL]).success, 'second pending');
        assert.ok(call(h, 'release', 'buyer').success);
        h.deposit('buyer', ADDR, TICK, '7');
        for (const m of ['release', 'refund', 'timeout', 'cancel', 'fund', 'requestDelivery'])
            for (const c of ACTORS) assert.ok(!call(h, m, c, [URL]).success, m + ' by ' + c + ' after release');
    });

    it('timeout honours the deadline anchored at fund() exactly', function () {
        const h = setup('200', 5);
        h.mineBlock(10);
        h.deposit('buyer', ADDR, TICK, '200');
        assert.ok(call(h, 'fund', 'buyer').success);
        h.mineBlock(4);
        assert.ok(!call(h, 'timeout', 'buyer').success, 'one block early');
        h.mineBlock(1);
        assert.ok(call(h, 'timeout', 'buyer').success);
        assert.strictEqual(h.ledger.getBalance('buyer', TICK), '1000');
    });

    it('boundaries: 1 base unit, exact fund at a large amount, and a surplus sweep', function () {
        let h = setup('0.00000001');
        h.deposit('buyer', ADDR, TICK, '0.00000001');
        assert.ok(call(h, 'fund', 'buyer').success);
        assert.ok(call(h, 'release', 'arbiter').success);
        assert.strictEqual(h.ledger.getBalance('seller', TICK), '0.00000001');

        h = new AttestHarness();
        h.seedBalance('buyer', TICK, '92233720368.54775807');
        assert.ok(h.deploy({ code: CODE, deployer: 'buyer', contractAddress: ADDR,
            params: ['buyer', 'seller', 'arbiter', TICK, '92233720368.54775807', '3', MARKER] }).success);
        h.deposit('buyer', ADDR, TICK, '92233720368.54775806');
        assert.ok(!call(h, 'fund', 'buyer').success, 'one base unit short');
        h.deposit('buyer', ADDR, TICK, '0.00000001');
        assert.ok(call(h, 'fund', 'buyer').success);

        // Settlement sweeps the whole held balance (documented), surplus included.
        h = setup('200');
        h.deposit('buyer', ADDR, TICK, '250');
        assert.ok(call(h, 'fund', 'buyer').success);
        const r = call(h, 'refund', 'seller');
        assert.strictEqual(r.actions[0].params.quantity, '250');
        assert.strictEqual(h.ledger.total(TICK), '1000');
    });

    it('constructor boundaries revert', function () {
        const bad = [['0', '3', MARKER], ['-1', '3', MARKER], ['1e2', '3', MARKER], ['200', '0', MARKER],
            ['200', '1000001', MARKER], ['200', '3', ''], ['Infinity', '3', MARKER]];
        for (const p of bad) {
            const h = new AttestHarness();
            const r = h.deploy({ code: CODE, deployer: 'buyer', contractAddress: ADDR,
                params: ['buyer', 'seller', 'arbiter', TICK, p[0], p[1], p[2]] });
            assert.ok(!r.success, p.join(','));
        }
    });

    // NOTE (not a finding): an 'ok' response whose payload is not a string throws in
    // indexOf, so the callback reverts and `pending` stays set; requestDelivery is then
    // blocked while the manual paths still settle. Whether the indexer can anchor an
    // ok response without a string payload is outside this harness.
    it('note: a malformed ok payload blocks automation but not the manual paths', function () {
        const h = funded();
        const id = call(h, 'requestDelivery', 'buyer', [URL]).result;
        h.seedResponse(id, null, 'ok');
        assert.ok(!call(h, 'onDelivery', 'buyer', [id]).success);
        assert.strictEqual(h.state(ADDR, 'pending'), id);
        assert.ok(!call(h, 'requestDelivery', 'buyer', [URL]).success);
        assert.ok(call(h, 'refund', 'arbiter').success);
        assert.strictEqual(h.ledger.getBalance('buyer', TICK), '1000');
    });
});
