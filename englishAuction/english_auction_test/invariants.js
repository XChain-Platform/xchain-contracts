// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// english_auction_test/invariants.js: seeded invariant tests for englishAuction.js on the in-process harness
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

const CODE = fs.readFileSync(path.join(__dirname, '..', 'englishAuction.js'), 'utf8');
const ADDR = 'C:BTC:9';
const ITEM = 'ITEM';
const BID = 'BID';
const SELLER = 'seller';
const BIDDERS = ['b1', 'b2', 'b3', 'b4'];
const ACTORS = [SELLER].concat(BIDDERS, ['stranger']);
const SEED_BID = '1000000';

function add(a, b) { return fixed(bn(a).plus(bn(b))); }
function sub(a, b) { return fixed(bn(a).minus(bn(b))); }
function eqExact(a, b) { return bn(a).eq(bn(b)); }
function unit(d) { return fixed(bn(1).div(bn(10).pow(d))); }
function floorDec(v, d) { return fixed(bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_DOWN)); }
function bal(h, who, tick) { return h.ledger.getBalance(who, tick); }
function call(h, method, caller) { return h.execute({ contractAddress: ADDR, method: method, caller: caller }); }
function sentTo(r, who, tick) {
    let t = '0';
    for (const a of r.actions) if (a.action === 'SEND' && a.params.destination === who && a.params.tick === tick) t = add(t, a.settled);
    return t;
}

// o: { itemDec, bidDec, itemAmount, minBid, window }
function setup(o) {
    const h = new Harness();
    h.ledger.setTokenDecimals(ITEM, o.itemDec);
    h.ledger.setTokenDecimals(BID, o.bidDec);
    h.seedBalance(SELLER, ITEM, fixed(bn(o.itemAmount).times(4)));
    for (const a of ACTORS) h.seedBalance(a, BID, SEED_BID);
    const r = h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR,
        params: [SELLER, ITEM, o.itemAmount, BID, o.minBid, String(o.window)] });
    assert.ok(r.success, r.error);
    return h;
}

const TERMS = [
    { itemDec: 0, itemAmount: '10', minBid: '50', window: 5 },
    { itemDec: 8, itemAmount: '0.00000001', minBid: '0.00000001', window: 3 },
    { itemDec: 2, itemAmount: '1.25', minBid: '0.5', window: 10 },
    { itemDec: 0, itemAmount: '1', minBid: '1000', window: 1 }
];

function runSeed(seed) {
    const R = rng(seed);
    const o = Object.assign({ bidDec: R.pick([0, 2, 8]) }, R.pick(TERMS));
    o.minBid = floorDec(o.minBid, o.bidDec) === '0' ? '1' : o.minBid;
    const tag = 'seed ' + seed + ' ' + JSON.stringify(o);
    const h = setup(o);
    const itemTotal = h.ledger.total(ITEM);
    const bidTotal = h.ledger.total(BID);
    const m = { stray: '0', itemHeld: '0', high: '0', leader: null, settled: 0 };
    const uBid = unit(o.bidDec);

    for (let step = 0; step < 35; step++) {
        const roll = R.next();
        const who = R.pick(ACTORS);
        const status = h.state(ADDR, 'status');
        const deadline = h.state(ADDR, 'deadline');
        const open = status === 'ACTIVE' && h.ledger.blockHeight < parseInt(deadline, 10);
        if (roll < 0.12) {
            const amt = R.next() < 0.8 ? o.itemAmount : sub(o.itemAmount, unit(o.itemDec));
            if (!bn(amt).isZero() && status === 'INIT' && bn(m.itemHeld).isZero()) {
                h.deposit(SELLER, ADDR, ITEM, amt);
                m.itemHeld = add(m.itemHeld, amt);
            }
        } else if (roll < 0.22) {
            const r = call(h, 'fund', who);
            assert.strictEqual(r.success, status === 'INIT' && who === SELLER && bn(m.itemHeld).gte(bn(o.itemAmount)),
                tag + ': fund outcome by ' + who + ' ' + r.error);
        } else if (roll < 0.6) {
            const bidder = R.pick(BIDDERS);
            const ref = bn(m.high).gt(bn(o.minBid)) ? m.high : o.minBid;
            const pick = R.pick(['under', 'equal', 'plus1', 'plus1', 'double']);
            let amt = pick === 'under' ? sub(ref, uBid) : pick === 'equal' ? ref : pick === 'plus1' ? add(ref, uBid) : fixed(bn(ref).times(2));
            if (bn(amt).lte(0)) amt = uBid;
            h.deposit(bidder, ADDR, BID, amt);
            const newBid = add(m.stray, amt);
            const r = call(h, 'bid', bidder);
            const ok = open && bidder !== m.leader && bn(newBid).gte(bn(o.minBid)) && bn(newBid).gt(bn(m.high));
            assert.strictEqual(r.success, ok, tag + ': bid outcome ' + newBid + ' vs ' + m.high + ' ' + r.error);
            if (ok) {
                if (m.leader) assert.ok(eqExact(sentTo(r, m.leader, BID), m.high), tag + ': outbid refund');
                else assert.strictEqual(r.actions.length, 0, tag + ': first bid emitted');
                m.high = newBid; m.leader = bidder; m.stray = '0';
                assert.ok(eqExact(h.state(ADDR, 'highBid'), newBid), tag + ': highBid state');
            } else {
                m.stray = newBid;
            }
        } else if (roll < 0.65) {
            h.deposit(R.pick(BIDDERS), ADDR, BID, uBid);
            m.stray = add(m.stray, uBid);
        } else if (roll < 0.82) {
            h.mineBlock(R.int(1, 3));
        } else if (roll < 0.92) {
            const r = call(h, 'settle', who);
            const ok = status === 'ACTIVE' && h.ledger.blockHeight >= parseInt(deadline, 10);
            assert.strictEqual(r.success, ok, tag + ': settle outcome ' + r.error);
            if (ok) {
                m.settled++;
                if (m.leader) {
                    assert.strictEqual(h.state(ADDR, 'status'), 'SOLD');
                    assert.ok(eqExact(sentTo(r, m.leader, ITEM), o.itemAmount), tag + ': winner item');
                    assert.ok(eqExact(sentTo(r, SELLER, BID), m.high), tag + ': seller proceeds');
                    m.high = '0';
                } else {
                    assert.strictEqual(h.state(ADDR, 'status'), 'UNSOLD');
                    assert.ok(eqExact(sentTo(r, SELLER, ITEM), o.itemAmount), tag + ': unsold return');
                }
                m.itemHeld = sub(m.itemHeld, o.itemAmount);
            }
        } else {
            const r = call(h, 'cancel', who);
            const ok = who === SELLER && !m.leader && (status === 'ACTIVE' || (status === 'INIT' && bn(m.itemHeld).gt(0)));
            assert.strictEqual(r.success, ok, tag + ': cancel outcome by ' + who + ' in ' + status + ' ' + r.error);
            if (ok) m.itemHeld = sub(m.itemHeld, sentTo(r, SELLER, ITEM));
        }
        assert.strictEqual(h.ledger.total(ITEM), itemTotal, tag + ' step ' + step + ': ITEM supply drift');
        assert.strictEqual(h.ledger.total(BID), bidTotal, tag + ' step ' + step + ': BID supply drift');
        assert.ok(eqExact(bal(h, ADDR, BID), add(m.high, m.stray)), tag + ' step ' + step + ': BID custody != highBid + strays');
        assert.ok(eqExact(bal(h, ADDR, ITEM), m.itemHeld), tag + ' step ' + step + ': ITEM custody');
        if (h.state(ADDR, 'status') === 'ACTIVE') assert.ok(bn(bal(h, ADDR, ITEM)).gte(bn(o.itemAmount)), tag + ': active but under-collateralised');
        assert.ok(m.settled <= 1, tag + ': settled twice');
    }
    const st = h.state(ADDR, 'status');
    if (st === 'SOLD' || st === 'UNSOLD' || st === 'CANCELLED') {
        h.deposit('b1', ADDR, BID, fixed(bn(o.minBid).times(10)));
        for (const meth of ['fund', 'bid', 'settle', 'cancel']) for (const c of ACTORS)
            assert.ok(!call(h, meth, c).success, tag + ': ' + meth + ' by ' + c + ' after ' + st);
    }
    return h;
}

const STD = { itemDec: 0, bidDec: 8, itemAmount: '10', minBid: '50', window: 5 };

function funded(o, deposit) {
    const h = setup(o);
    h.deposit(SELLER, ADDR, ITEM, deposit || o.itemAmount);
    const r = call(h, 'fund', SELLER);
    assert.ok(r.success, r.error);
    return h;
}
function bidWith(h, who, amt) { h.deposit(who, ADDR, BID, amt); return call(h, 'bid', who); }

(available ? describe : describe.skip)('englishAuction invariants (in-process)', function () {
    it('conservation, refund-on-outbid and single settlement across seeded random call sequences', function () {
        const seen = {};
        for (let seed = 1; seed <= 200; seed++) {
            const st = runSeed(seed).state(ADDR, 'status');
            seen[st] = (seen[st] || 0) + 1;
        }
        // Coverage: the sequences reach every terminal and live state.
        for (const st of ['INIT', 'ACTIVE', 'SOLD', 'UNSOLD', 'CANCELLED']) assert.ok(seen[st] >= 5, 'too few runs ending ' + st + ': ' + JSON.stringify(seen));
    });

    it('determinism: the same seeded sequence yields the same ledger and state', function () {
        for (const seed of [4, 31, 99]) assert.deepStrictEqual(runSeed(seed).ledger.snapshot(), runSeed(seed).ledger.snapshot());
    });

    it('authorization: only the seller funds and cancels; anyone settles after the deadline', function () {
        for (const c of ACTORS) {
            const h = setup(STD);
            h.deposit(SELLER, ADDR, ITEM, '10');
            assert.strictEqual(call(h, 'fund', c).success, c === SELLER, 'fund by ' + c);
            assert.strictEqual(call(h, 'cancel', c).success, c === SELLER, 'cancel by ' + c);
            const g = funded(STD);
            assert.ok(!call(g, 'settle', c).success, 'settle before deadline by ' + c);
            g.mineBlock(5);
            assert.ok(call(g, 'settle', c).success, 'settle at deadline by ' + c);
        }
    });

    it('lifecycle: no bid after the deadline, no cancel after a bid, no self-raise, no double settle', function () {
        const h = funded(STD);
        assert.ok(bidWith(h, 'b1', '50').success);
        assert.ok(!call(h, 'cancel', SELLER).success, 'cancel after a bid');
        assert.ok(!bidWith(h, 'b1', '60').success, 'self-raise');
        h.mineBlock(5);
        assert.ok(!bidWith(h, 'b2', '1000').success, 'bid at the deadline');
        assert.ok(call(h, 'settle', 'stranger').success);
        assert.ok(!call(h, 'settle', 'stranger').success, 'double settle');
        assert.strictEqual(bal(h, 'b1', ITEM), '10');
        assert.strictEqual(bal(h, SELLER, BID), add(SEED_BID, '50'));
    });

    it('bid boundaries: one base unit below the minimum or at the high bid is refused, one above wins', function () {
        const h = funded(STD);
        assert.ok(!bidWith(h, 'b1', '49.99999999').success);
        const g = funded(STD);
        assert.ok(bidWith(g, 'b1', '50').success);
        assert.ok(!bidWith(g, 'b2', '50').success, 'equal bid');
        const k = funded(STD);
        assert.ok(bidWith(k, 'b1', '50').success);
        const r = bidWith(k, 'b2', '50.00000001');
        assert.ok(r.success, r.error);
        assert.strictEqual(sentTo(r, 'b1', BID), '50');
    });

    it('huge values: a raise of one base unit over a 1e30 high bid is a raise', function () {
        const h = funded(STD);
        const big = '1000000000000000000000000000000';
        h.seedBalance('b1', BID, big);
        h.seedBalance('b2', BID, add(big, '0.00000001'));
        assert.ok(bidWith(h, 'b1', big).success);
        const r = bidWith(h, 'b2', add(big, '0.00000001'));
        assert.ok(r.success, r.error);
        assert.strictEqual(sentTo(r, 'b1', BID), big);
    });

    it('constructor boundaries revert cleanly', function () {
        const bad = [['0', '50', '5'], ['1e1', '50', '5'], ['10', '0', '5'], ['10', 'Infinity', '5'], ['10', '50', '0'],
            ['10', '50', '1000001'], ['10', '50', '1e3'], ['.5', '50', '5'], ['10', '-1', '5']];
        for (const p of bad) {
            const h = new Harness();
            assert.ok(!h.deploy({ code: CODE, deployer: SELLER, contractAddress: ADDR, params: [SELLER, ITEM, p[0], BID, p[1], p[2]] }).success, p.join(','));
        }
    });

    // Regression: fund() accepts any custody at or above itemAmount, but cancel() from ACTIVE and
    // both settle() branches moved exactly itemAmount, so an item surplus deposited ahead of
    // fund() was left in a terminal contract with no method able to return it.
    it('an item surplus deposited before fund() is returned to the seller on cancel and on settle', function () {
        const h = funded(STD, '11');
        assert.ok(call(h, 'cancel', SELLER).success);
        assert.strictEqual(bal(h, ADDR, ITEM), '0', 'cancel left item in a CANCELLED contract');
        assert.strictEqual(bal(h, SELLER, ITEM), '40');
        const u = funded(STD, '11');
        u.mineBlock(5);
        assert.ok(call(u, 'settle', 'stranger').success);
        assert.strictEqual(bal(u, ADDR, ITEM), '0', 'settle left item in an UNSOLD contract');
        const g = funded(STD, '11');
        assert.ok(bidWith(g, 'b1', '50').success);
        g.mineBlock(5);
        assert.ok(call(g, 'settle', 'stranger').success);
        assert.strictEqual(bal(g, 'b1', ITEM), '10');
        assert.strictEqual(bal(g, ADDR, ITEM), '0', 'settle left item in a SOLD contract');
        assert.strictEqual(bal(g, SELLER, ITEM), '30');
    });
});
