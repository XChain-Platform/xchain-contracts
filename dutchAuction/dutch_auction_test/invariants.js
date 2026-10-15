// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// dutch_auction_test/invariants.js: seeded invariant tests for dutchAuction.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const inproc = require('../../test/helpers/harness.js');
const { available, rng, M, bn, fixed } = inproc;

// The shared harness builds its tolerance band with mathjs max(), which compares within
// mathjs's own epsilon and so drops the 1e-15 absolute floor for operands below about
// 1e-3. This wrapper restores the documented rule, |a - b| <= max(1e-12 x larger, 1e-15),
// using exact decimal comparisons only.
function documentedCompare(a, b) {
    const x = bn(a), y = bn(b);
    const larger = x.abs().gt(y.abs()) ? x.abs() : y.abs();
    let band = larger.times('1e-12');
    if (band.lt('1e-15')) band = bn('1e-15');
    if (x.minus(y).abs().lte(band)) return 0;
    return x.gt(y) ? 1 : -1;
}
class Harness extends inproc.Harness {
    makeApi(addr, params, caller, actions) {
        const api = super.makeApi(addr, params, caller, actions);
        api.math.gt = (a, b) => documentedCompare(a, b) > 0;
        api.math.gte = (a, b) => documentedCompare(a, b) >= 0;
        api.math.lt = (a, b) => documentedCompare(a, b) < 0;
        api.math.lte = (a, b) => documentedCompare(a, b) <= 0;
        api.math.eq = (a, b) => documentedCompare(a, b) === 0;
        api.math.compare = documentedCompare;
        return api;
    }
}

const CODE = fs.readFileSync(path.join(__dirname, '..', 'dutchAuction.js'), 'utf8');
const ADDR = 'C:BTC:7';
const ITEM = 'ITEM';
const BID = 'BID';
const SELLER = 'seller';
const BUYERS = ['b1', 'b2', 'b3'];
const ACTORS = [SELLER].concat(BUYERS, ['stranger']);
const SEED_BID = '1000000';

function add(a, b) { return fixed(bn(a).plus(bn(b))); }
function sub(a, b) { return fixed(bn(a).minus(bn(b))); }
function eqExact(a, b) { return bn(a).eq(bn(b)); }
function floorDec(v, d) { return fixed(bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_DOWN)); }
function bal(h, who, tick) { return h.ledger.getBalance(who, tick); }
function call(h, method, caller) { return h.execute({ contractAddress: ADDR, method: method, caller: caller }); }
function sentTo(r, who, tick) {
    let t = '0';
    for (const a of r.actions) if (a.action === 'SEND' && a.params.destination === who && a.params.tick === tick) t = add(t, a.settled);
    return t;
}

// o: { itemDec, bidDec, itemAmount, start, end, duration }
function setup(o) {
    const h = new Harness();
    h.ledger.setTokenDecimals(ITEM, o.itemDec);
    h.ledger.setTokenDecimals(BID, o.bidDec);
    h.seedBalance(SELLER, ITEM, fixed(bn(o.itemAmount).times(4)));
    for (const a of ACTORS) h.seedBalance(a, BID, SEED_BID);
    const r = h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR,
        params: [SELLER, ITEM, o.itemAmount, BID, o.start, o.end, String(o.duration)] });
    assert.ok(r.success, r.error);
    return h;
}

// The asking price the contract computes, with the same 64-digit steps, floored to the bid grid.
function expectedPrice(h, o) {
    const elapsed = h.ledger.blockHeight - parseInt(h.state(ADDR, 'start'), 10);
    let p;
    if (elapsed >= o.duration) p = o.end;
    else {
        const drop = fixed(bn(o.start).minus(bn(o.end)));
        const decayed = fixed(bn(fixed(bn(drop).times(bn(String(elapsed))))).div(bn(String(o.duration))));
        p = fixed(bn(o.start).minus(bn(decayed)));
    }
    return floorDec(p, o.bidDec);
}

const TERMS = [
    { itemDec: 0, itemAmount: '1', start: '1000', end: '100', duration: 10 },
    { itemDec: 8, itemAmount: '2.5', start: '10.123456789', end: '0.00000003', duration: 7 },
    { itemDec: 2, itemAmount: '0.01', start: '5', end: '4.99999999', duration: 3 },
    { itemDec: 8, itemAmount: '0.00000001', start: '1', end: '0.5', duration: 1 },
    { itemDec: 0, itemAmount: '3', start: '7', end: '1', duration: 1000 }
];

function runSeed(seed) {
    const R = rng(seed);
    const o = Object.assign({ bidDec: R.pick([0, 2, 8, 18]) }, R.pick(TERMS));
    const tag = 'seed ' + seed + ' ' + JSON.stringify(o);
    const h = setup(o);
    const itemTotal = h.ledger.total(ITEM);
    const bidTotal = h.ledger.total(BID);
    const m = { stray: '0', itemHeld: '0', sold: 0, lastPrice: null };

    for (let step = 0; step < 30; step++) {
        const roll = R.next();
        const who = R.pick(ACTORS);
        const status = h.state(ADDR, 'status');
        if (roll < 0.15) {
            // The seller deposits the item, exactly or short by a base unit.
            const amt = R.next() < 0.8 ? o.itemAmount : sub(o.itemAmount, fixed(bn(1).div(bn(10).pow(o.itemDec))));
            if (!bn(amt).isZero() && bn(bal(h, SELLER, ITEM)).gte(bn(amt)) && status === 'INIT' && bn(m.itemHeld).isZero()) {
                h.deposit(SELLER, ADDR, ITEM, amt);
                m.itemHeld = add(m.itemHeld, amt);
            }
        } else if (roll < 0.27) {
            const r = call(h, 'fund', who);
            const ok = status === 'INIT' && who === SELLER && bn(m.itemHeld).gte(bn(o.itemAmount));
            assert.strictEqual(r.success, ok, tag + ': fund outcome by ' + who + ' ' + r.error);
            if (ok) m.lastPrice = null;
        } else if (roll < 0.6) {
            const buyer = R.pick(BUYERS);
            let price = null;
            if (status === 'ACTIVE') price = expectedPrice(h, o);
            const base = price || o.end;
            const factor = R.pick(['0', '0.5', '1', '1', '1.25', '3']);
            const amt = floorDec(fixed(bn(base).times(bn(factor))), o.bidDec);
            if (!bn(amt).isZero()) h.deposit(buyer, ADDR, BID, amt);
            const heldNow = bal(h, ADDR, BID);
            const r = call(h, 'buy', buyer);
            if (status !== 'ACTIVE' || bn(price).isZero()) {
                assert.ok(!r.success, tag + ': buy succeeded while ' + status);
                m.stray = add(m.stray, amt);
            } else if (bn(heldNow).lt(bn(price))) {
                assert.ok(r.success && r.result === 'underpaid', tag + ': short buy not refunded: ' + r.error);
                assert.ok(eqExact(sentTo(r, buyer, BID), heldNow), tag + ': underpay refund amount');
                m.stray = '0';
            } else {
                assert.ok(r.success && r.result === undefined, tag + ': buy failed: ' + r.error);
                m.sold++;
                assert.strictEqual(h.state(ADDR, 'status'), 'SOLD');
                assert.ok(eqExact(h.state(ADDR, 'soldPrice'), price), tag + ': sold at ' + h.state(ADDR, 'soldPrice') + ' not ' + price);
                assert.ok(bn(price).lte(bn(o.start)) && bn(price).gte(bn(floorDec(o.end, o.bidDec))), tag + ': price out of range');
                assert.ok(eqExact(sentTo(r, SELLER, BID), price), tag + ': seller payout');
                assert.ok(eqExact(sentTo(r, buyer, ITEM), o.itemAmount), tag + ': item delivery');
                assert.ok(eqExact(sentTo(r, buyer, BID), sub(heldNow, price)), tag + ': excess refund');
                m.stray = '0';
                m.itemHeld = sub(m.itemHeld, o.itemAmount);
            }
        } else if (roll < 0.67) {
            const amt = floorDec(o.end, o.bidDec);
            if (!bn(amt).isZero()) { h.deposit(R.pick(BUYERS), ADDR, BID, amt); m.stray = add(m.stray, amt); }
        } else if (roll < 0.85) {
            h.mineBlock(R.int(1, 4));
            if (status === 'ACTIVE') {
                const p = expectedPrice(h, o);
                if (m.lastPrice !== null) assert.ok(bn(p).lte(bn(m.lastPrice)), tag + ': price rose');
                m.lastPrice = p;
                const info = JSON.parse(call(h, 'info', who).result);
                assert.ok(eqExact(floorDec(info.currentPrice, o.bidDec), p), tag + ': info price');
            }
        } else {
            const r = call(h, 'cancel', who);
            const ok = who === SELLER && (status === 'ACTIVE' || (status === 'INIT' && bn(m.itemHeld).gt(0)));
            assert.strictEqual(r.success, ok, tag + ': cancel outcome by ' + who + ' in ' + status + ' ' + r.error);
            if (ok) m.itemHeld = sub(m.itemHeld, sentTo(r, SELLER, ITEM));
        }
        assert.strictEqual(h.ledger.total(ITEM), itemTotal, tag + ' step ' + step + ': ITEM supply drift');
        assert.strictEqual(h.ledger.total(BID), bidTotal, tag + ' step ' + step + ': BID supply drift');
        assert.ok(eqExact(bal(h, ADDR, BID), m.stray), tag + ' step ' + step + ': BID custody != strays');
        assert.ok(eqExact(bal(h, ADDR, ITEM), m.itemHeld), tag + ' step ' + step + ': ITEM custody');
        if (h.state(ADDR, 'status') === 'ACTIVE') assert.ok(bn(bal(h, ADDR, ITEM)).gte(bn(o.itemAmount)), tag + ': active but under-collateralised');
        assert.ok(m.sold <= 1, tag + ': sold twice');
    }
    // Terminal states accept nothing further.
    const st = h.state(ADDR, 'status');
    if (st === 'SOLD' || st === 'CANCELLED')
        for (const meth of ['fund', 'buy', 'cancel']) for (const c of ACTORS)
            assert.ok(!call(h, meth, c).success, tag + ': ' + meth + ' by ' + c + ' after ' + st);
    return h;
}

const STD = { itemDec: 0, bidDec: 8, itemAmount: '10', start: '1000', end: '100', duration: 100 };

function funded(o, deposit) {
    const h = setup(o);
    h.deposit(SELLER, ADDR, ITEM, deposit || o.itemAmount);
    const r = call(h, 'fund', SELLER);
    assert.ok(r.success, r.error);
    return h;
}
function buyWith(h, who, amt) { h.deposit(who, ADDR, BID, amt); return call(h, 'buy', who); }

(available ? describe : describe.skip)('dutchAuction invariants (in-process)', function () {
    it('conservation, single sale and price monotonicity across seeded random call sequences', function () {
        const seen = {};
        for (let seed = 1; seed <= 200; seed++) {
            const st = runSeed(seed).state(ADDR, 'status');
            seen[st] = (seen[st] || 0) + 1;
        }
        // Coverage: the sequences reach every terminal and live state.
        for (const st of ['INIT', 'ACTIVE', 'SOLD', 'CANCELLED']) assert.ok(seen[st] >= 5, 'too few runs ending ' + st + ': ' + JSON.stringify(seen));
    });

    it('determinism: the same seeded sequence yields the same ledger and state', function () {
        for (const seed of [5, 23, 77]) assert.deepStrictEqual(runSeed(seed).ledger.snapshot(), runSeed(seed).ledger.snapshot());
    });

    it('authorization: only the seller funds and cancels', function () {
        for (const c of ACTORS) {
            const h = setup(STD);
            h.deposit(SELLER, ADDR, ITEM, '10');
            assert.strictEqual(call(h, 'fund', c).success, c === SELLER, 'fund by ' + c);
            assert.strictEqual(call(h, 'cancel', c).success, c === SELLER, 'cancel by ' + c);
        }
    });

    it('lifecycle: one sale, no buy before fund or after sale or cancel, no cancel after sale', function () {
        const h = setup(STD);
        assert.ok(!buyWith(h, 'b1', '1000').success, 'buy before fund');
        const g = funded(STD);
        assert.ok(buyWith(g, 'b1', '1000').success);
        assert.ok(!buyWith(g, 'b2', '1000').success, 'second buy');
        assert.ok(!call(g, 'cancel', SELLER).success, 'cancel after sale');
        assert.ok(!call(g, 'fund', SELLER).success, 'fund after sale');
        const k = funded(STD);
        assert.ok(call(k, 'cancel', SELLER).success);
        assert.ok(!call(k, 'cancel', SELLER).success, 'double cancel');
        assert.ok(!buyWith(k, 'b1', '1000').success, 'buy after cancel');
    });

    it('payment boundary: one base unit short is refunded as underpaid, the exact price buys', function () {
        const h = funded(STD);
        h.mineBlock(1);
        const price = '991';
        const r = buyWith(h, 'b1', '990.99999999');
        assert.ok(r.success && r.result === 'underpaid');
        assert.strictEqual(bal(h, 'b1', BID), SEED_BID);
        const s = buyWith(h, 'b2', price);
        assert.ok(s.success && s.result === undefined, s.error);
        assert.strictEqual(bal(h, SELLER, BID), add(SEED_BID, price));
        assert.strictEqual(bal(h, 'b2', ITEM), '10');
    });

    it('price floor: an endPrice below one bid-tick unit refuses the sale instead of giving the item away', function () {
        const o = { itemDec: 0, bidDec: 0, itemAmount: '1', start: '2', end: '0.5', duration: 1 };
        const h = funded(o);
        h.mineBlock(1);
        h.deposit('b1', ADDR, BID, '1');
        const r = call(h, 'buy', 'b1');
        assert.ok(!r.success && /below one unit/.test(r.error), r.error);
        assert.strictEqual(bal(h, ADDR, ITEM), '1');
    });

    it('huge values: a 1e40 start price decays and settles exactly', function () {
        const o = { itemDec: 8, bidDec: 8, itemAmount: '1', start: '10000000000000000000000000000000000000000', end: '0.00000001', duration: 1000000 };
        const h = funded(o);
        h.mineBlock(999999);
        const p = expectedPrice(h, o);
        h.seedBalance('b1', BID, p);
        const r = buyWith(h, 'b1', p);
        assert.ok(r.success && r.result === undefined, r.error);
        assert.strictEqual(sentTo(r, SELLER, BID), p);
    });

    it('constructor boundaries revert cleanly', function () {
        const bad = [
            ['0', '10', '1'], ['1e1', '10', '1'], ['1', '1e3', '1'], ['1', '10', '0'], ['1', '10', '10'],
            ['1', '10', '11'], ['1', '-10', '1'], ['1', '10', '.5'], ['1', '0x10', '1']
        ];
        for (const p of bad) {
            const h = new Harness();
            const r = h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR, params: [SELLER, ITEM, p[0], BID, p[1], p[2], '10'] });
            assert.ok(!r.success, p.join(','));
        }
        for (const d of ['0', '1000001', '1e3', ' 5', '5.0']) {
            const h = new Harness();
            assert.ok(!h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR, params: [SELLER, ITEM, '1', BID, '10', '1', d] }).success, d);
        }
    });

    // Regression: fund() accepts any custody at or above itemAmount, but cancel() from ACTIVE and
    // buy() each moved exactly itemAmount, so an item surplus deposited ahead of fund() was
    // left in a terminal contract with no method able to return it.
    it('an item surplus deposited before fund() is returned to the seller on cancel and on sale', function () {
        const h = funded(STD, '11');
        assert.ok(call(h, 'cancel', SELLER).success);
        assert.strictEqual(bal(h, ADDR, ITEM), '0', 'cancel left item in a CANCELLED contract');
        assert.strictEqual(bal(h, SELLER, ITEM), '40');
        const g = funded(STD, '11');
        const r = buyWith(g, 'b1', '1000');
        assert.ok(r.success && r.result === undefined, r.error);
        assert.strictEqual(bal(g, 'b1', ITEM), '10');
        assert.strictEqual(bal(g, ADDR, ITEM), '0', 'buy left item in a SOLD contract');
        assert.strictEqual(bal(g, SELLER, ITEM), '30');
    });
});
