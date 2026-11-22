// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// cardDispenser_test/invariants.js: seeded invariant tests for cardDispenser.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Harness assumption: getTokenInfo(tick) returns the card's record (with DECIMALS)
// only when the contract holds a balance entry for that tick, which is how the
// template's own comments describe the indexer snapshot.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, bn, roundHalfUp } = require('../../test/helpers/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'cardDispenser.js'), 'utf8');
const ADDR = 'C:BTC:7';
const PAY = 'PAY';
const CARDS = ['CA', 'CB', 'CC'];
const PRICE = '2.5';

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

function setup(opts) {
    const o = opts || {};
    const h = new TolHarness();
    const cards = o.cards || CARDS;
    h.seedBalance('buyer', PAY, '10000000');
    h.seedBalance('buyer2', PAY, '10000000');
    for (const c of cards) {
        if (o.decimals !== undefined) h.ledger.setTokenDecimals(c, o.decimals);
        h.seedBalance('owner', c, o.ownerCards || '1000');
    }
    const r = h.deploy({ code: CODE, deployer: 'owner', contractAddress: ADDR,
        params: [PAY, o.price || PRICE, o.unit || '1'].concat(cards) });
    assert.ok(r.success, r.error);
    const stock = o.stock || [5, 2, 1];
    cards.forEach((c, i) => { if (stock[i]) h.deposit('owner', ADDR, c, String(stock[i])); });
    return h;
}

function call(h, method, caller, params) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller });
}

function buy(h, who, amount) {
    h.deposit(who, ADDR, PAY, amount || PRICE);
    return call(h, 'draw', who);
}

function stock(h) { return JSON.parse(call(h, 'info', 'anyone').result).stock; }

function totals(h) {
    const t = { PAY: h.ledger.total(PAY) };
    for (const c of CARDS) t[c] = h.ledger.total(c);
    return t;
}

// One random step on the dispenser: asserts per-step properties and returns the draw outcome, if any.
function step(h, R, seed) {
    const who = R.pick(['buyer', 'buyer2', 'owner', 'stranger']);
    const roll = R.next();
    if (roll < 0.55 && who !== 'owner' && who !== 'stranger') {
        const amt = R.pick([PRICE, PRICE, '2.49999999', '3', '0.00000001', '10']);
        const before = stock(h);
        const acct = h.state(ADDR, 'acctPay');
        const nonce = h.state(ADDR, 'nonce');
        h.deposit(who, ADDR, PAY, amt);
        const paid = bn(h.ledger.getBalance(ADDR, PAY)).minus(bn(acct));
        const r = call(h, 'draw', who);
        if (!r.success) {
            assert.ok(/underpaid/.test(r.error), 'seed ' + seed + ' unexpected draw error ' + r.error);
            assert.ok(paid.lt(bn(PRICE)), 'seed ' + seed + ' paid draw refused');
            return;
        }
        assert.ok(paid.gte(bn(PRICE)), 'seed ' + seed + ' draw accepted an underpayment');
        assert.strictEqual(h.state(ADDR, 'acctPay'), h.ledger.getBalance(ADDR, PAY), 'seed ' + seed + ' watermark off custody');
        const sends = r.actions;
        assert.strictEqual(sends.length, 1, 'seed ' + seed + ' one emission per draw');
        if (r.result === 'sold_out') {
            for (const c of CARDS) assert.strictEqual(before[c], '0', 'seed ' + seed + ' refunded while ' + c + ' in stock');
            assert.strictEqual(sends[0].params.tick, PAY);
            assert.strictEqual(sends[0].params.destination, who);
            assert.strictEqual(sends[0].settled, roundHalfUp(paid.toFixed(), 8), 'seed ' + seed + ' refund differs from payment');
            assert.strictEqual(h.state(ADDR, 'nonce'), nonce);
            return 'sold_out';
        } else {
            assert.ok(CARDS.indexOf(r.result) >= 0);
            assert.ok(bn(before[r.result]).gt(0), 'seed ' + seed + ' drew a card with no deliverable stock');
            assert.strictEqual(sends[0].params.tick, r.result);
            assert.strictEqual(sends[0].params.destination, who);
            assert.ok(bn(sends[0].settled).eq(bn(h.state(ADDR, 'unit'))), 'seed ' + seed + ' delivered amount differs from unit');
            assert.strictEqual(h.state(ADDR, 'nonce'), String(Number(nonce) + 1));
            return 'card';
        }
    } else if (roll < 0.75) {
        const tick = R.pick([PAY].concat(CARDS));
        const r = call(h, 'withdraw', who, [tick]);
        if (who !== 'owner') assert.ok(!r.success, 'seed ' + seed + ' withdraw by ' + who);
        if (r.success) {
            assert.strictEqual(h.ledger.getBalance(ADDR, tick), '0');
            if (tick === PAY) assert.strictEqual(h.state(ADDR, 'acctPay'), '0');
        }
    } else if (roll < 0.85) {
        h.deposit('owner', ADDR, R.pick(CARDS), String(R.int(1, 3)));
    } else {
        h.mineBlock(R.int(1, 2));
    }
}

(available ? describe : describe.skip)('cardDispenser invariants (in-process)', function () {
    it('conservation, watermark and delivery properties across seeded random sequences', function () {
        const seen = {};
        for (let seed = 1; seed <= 120; seed++) {
            const R = rng(seed);
            const h = setup();
            const t0 = totals(h);
            for (let i = 0; i < 30; i++) {
                const kind = step(h, R, seed);
                if (kind) seen[kind] = (seen[kind] || 0) + 1;
                assert.deepStrictEqual(totals(h), t0, 'seed ' + seed + ' supply drift');
            }
        }
        assert.ok(seen.card > 100 && seen.sold_out > 10, 'coverage ' + JSON.stringify(seen));
    });

    it('draw is weighted by stock and drains the pool without over-sending', function () {
        const h = setup({ stock: [3, 2, 1] });
        const got = {};
        for (let i = 0; i < 6; i++) {
            const r = buy(h, 'buyer');
            assert.ok(r.success && CARDS.indexOf(r.result) >= 0, r.error);
            got[r.result] = (got[r.result] || 0) + 1;
            h.mineBlock(1);
        }
        assert.deepStrictEqual(got, { CA: 3, CB: 2, CC: 1 });
        const r = buy(h, 'buyer');
        assert.strictEqual(r.result, 'sold_out');
        assert.strictEqual(h.ledger.getBalance(ADDR, PAY), '15');
        assert.strictEqual(h.state(ADDR, 'acctPay'), '15');
    });

    it('payment is measured exactly: one base unit short reverts, overpayment is kept', function () {
        const h = setup({ price: '1000000.00000001' });
        assert.ok(!buy(h, 'buyer', '1000000').success, 'one base unit short');
        h.deposit('buyer', ADDR, PAY, '0.00000001');
        assert.ok(call(h, 'draw', 'buyer').success, 'stranded deposit topped up');
        const r = buy(h, 'buyer2', '1000001');
        assert.ok(r.success);
        assert.strictEqual(h.state(ADDR, 'acctPay'), h.ledger.getBalance(ADDR, PAY));
    });

    it('authorization: only the owner withdraws, and a payTick sweep resets the watermark', function () {
        const h = setup();
        assert.ok(buy(h, 'buyer').success);
        for (const who of ['buyer', 'stranger', ADDR]) assert.ok(!call(h, 'withdraw', who, [PAY]).success, who);
        assert.ok(call(h, 'withdraw', 'owner', [PAY]).success);
        assert.strictEqual(h.state(ADDR, 'acctPay'), '0');
        assert.ok(!call(h, 'withdraw', 'owner', [PAY]).success, 'nothing to withdraw');
        assert.ok(buy(h, 'buyer').success, 'draw after sweep');
    });

    it('off-grid units weigh zero and refund (existing behaviour, control)', function () {
        let h = setup({ unit: '0.25', decimals: 0 });
        let r = buy(h, 'buyer');
        assert.strictEqual(r.result, 'sold_out');
        assert.strictEqual(h.ledger.getBalance('buyer', PAY), '10000000');
        h = setup({ unit: '1.5', decimals: 0 });
        assert.strictEqual(buy(h, 'buyer').result, 'sold_out');
        h = setup({ unit: '0.25', decimals: 2 });
        r = buy(h, 'buyer');
        assert.ok(CARDS.indexOf(r.result) >= 0);
        assert.strictEqual(r.actions[0].settled, '0.25');
    });

    it('a pick at r = total - 1 on a large total still maps to a card', function () {
        const h = setup({ unit: '0.00000001', stock: [1000000, 1000000, 1000000], ownerCards: '1000000' });
        for (let i = 0; i < 20; i++) {
            const r = buy(h, i % 2 ? 'buyer' : 'buyer2');
            assert.ok(r.success && CARDS.indexOf(r.result) >= 0, r.error);
        }
        assert.strictEqual(h.ledger.total('CA'), '1000000');
    });

    it('constructor boundaries revert', function () {
        const bad = [[PAY, '0', '1', 'CA'], [PAY, '1', '0', 'CA'], [PAY, '1', '1e0', 'CA'], [PAY, '1', '1'],
            [PAY, '1', '1', PAY], [PAY, '1', '1', 'A|B'], [PAY, '1', '.5', 'CA'], [PAY, '-1', '1', 'CA']];
        for (const p of bad) {
            const h = new TolHarness();
            assert.ok(!h.deploy({ code: CODE, deployer: 'owner', contractAddress: ADDR, params: p }).success, p.join(','));
        }
    });

    // Regression: deliverableCopies compared floorToDecimals(unit, d) to unit as STRINGS, so a
    // unit spelled with trailing zeros ('1.00000000', the spelling initialize() itself
    // gives as its example) was treated as off-grid on a card with fewer decimals, even
    // though it is exactly representable there. Every draw then refunded as sold out
    // while the contract held deliverable cards.
    it('a unit with trailing zeros on a lower-decimal card is deliverable', function () {
        for (const u of ['1.00000000', '1.0']) {
            const h = setup({ unit: u, decimals: 0, stock: [2, 0, 0] });
            assert.deepStrictEqual(stock(h), { CA: '2', CB: '0', CC: '0' }, 'info stock for unit ' + u);
            const r = buy(h, 'buyer');
            assert.strictEqual(r.result, 'CA', 'unit ' + u + ' on a 0-decimal card drew ' + r.result);
            assert.strictEqual(r.actions[0].settled, '1');
            assert.strictEqual(h.ledger.getBalance('buyer', 'CA'), '1');
        }
        const h = setup({ unit: '0.50', decimals: 1, stock: [1, 0, 0] });
        assert.strictEqual(buy(h, 'buyer').result, 'CA', 'unit 0.50 on a 1-decimal card');
        assert.strictEqual(roundHalfUp('0.50', 1), '0.5');
    });
});
