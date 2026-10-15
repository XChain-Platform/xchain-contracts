// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// crowdsale_test/invariants.js: seeded invariant tests for crowdsale.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const inproc = require('../../test/inproc/harness.js');
const { available, rng, M, bn, fixed, roundHalfUp } = inproc;

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

const CODE = fs.readFileSync(path.join(__dirname, '..', 'crowdsale.js'), 'utf8');
const ADDR = 'C:BTC:1';
const PAY = 'PAY';
const SALE = 'SALE';
const OWNER = 'owner';
const BUYERS = ['b1', 'b2', 'b3', 'b4'];
const ACTORS = [OWNER].concat(BUYERS, ['stranger']);
const SEED_PAY = '100000';
const DURATION = 20;

function unit(d) { return fixed(bn(1).div(bn(10).pow(d))); }
function floorDec(v, d) { return fixed(bn(v).toDecimalPlaces(d, M.BigNumber.ROUND_DOWN)); }
function add(a, b) { return fixed(bn(a).plus(bn(b))); }
function sub(a, b) { return fixed(bn(a).minus(bn(b))); }
function eqExact(a, b) { return bn(a).eq(bn(b)); }
function bal(h, who, tick) { return h.ledger.getBalance(who, tick); }

// Deploy a sale; payDec is the pay tick grid, opts carry the constructor terms.
function setup(o) {
    const h = new Harness();
    h.ledger.setTokenDecimals(PAY, o.payDec);
    for (const a of ACTORS) h.seedBalance(a, PAY, SEED_PAY);
    const r = h.deploy({ code: CODE, deployer: OWNER, contractAddress: ADDR,
        params: [OWNER, PAY, SALE, o.rate, o.soft, o.hard, String(o.duration || DURATION), String(o.saleDec)] });
    assert.ok(r.success, r.error);
    return h;
}

function call(h, method, caller) { return h.execute({ contractAddress: ADDR, method: method, caller: caller }); }
function buy(h, who, amount) { h.deposit(who, ADDR, PAY, amount); return call(h, 'buy', who); }
function sentTo(r, who, tick) {
    let t = '0';
    for (const a of r.actions) if (a.action === 'SEND' && a.params.destination === who && a.params.tick === tick) t = add(t, a.settled);
    return t;
}

// A random on-grid pay amount: whole units plus up to three decimal places of the grid.
function randomPay(R, payDec) {
    if (R.next() < 0.1) return unit(payDec);
    const whole = R.int(0, 60);
    const d = Math.min(payDec, 3);
    const frac = d > 0 ? fixed(bn(R.int(0, Math.pow(10, d) - 1)).div(bn(10).pow(d))) : '0';
    const v = add(whole, frac);
    return bn(v).isZero() ? unit(payDec) : v;
}

const RATES = ['10', '0.3', '1.5', '0.00000003', '7', '123.456789', '2'];
const CAPS = [['1', '50'], ['40', '200'], ['150', '200'], ['100', '1000'], ['30', '30']];

function runSeed(seed) {
    const R = rng(seed);
    const o = { payDec: R.pick([0, 2, 8]), saleDec: R.pick([0, 2, 8]), rate: R.pick(RATES) };
    const caps = R.pick(CAPS);
    o.soft = caps[0]; o.hard = caps[1];
    const h = setup(o);
    const tag = 'seed ' + seed + ' ' + JSON.stringify(o);
    const maxSale = fixed(bn(o.hard).times(bn(o.rate)));
    const minted = roundHalfUp(maxSale, o.saleDec);
    const uPay = unit(o.payDec);
    const tokensFor = (c) => floorDec(fixed(bn(c).times(bn(o.rate))), o.saleDec);

    const m = { orphan: '0', rec: {}, everRec: {}, paidOut: '0', claimed: '0', burned: '0', withdrawn: false,
        burnedOnce: false, finalized: false };

    const check = (where) => {
        const status = h.state(ADDR, 'status');
        assert.strictEqual(h.ledger.total(PAY), fixed(bn(SEED_PAY).times(ACTORS.length)), tag + ' ' + where + ': PAY supply drift');
        assert.strictEqual(h.ledger.total(SALE), h.ledger.tokens[SALE].SUPPLY, tag + ' ' + where + ': SALE total != SUPPLY');
        const raised = h.state(ADDR, 'raised');
        assert.ok(eqExact(h.state(ADDR, 'accountedPay'), raised), tag + ' ' + where + ': accountedPay != raised');
        let sumC = '0', sumTok = '0', outC = '0', outTok = '0';
        for (const b of BUYERS) {
            const c = m.everRec[b] || '0';
            sumC = add(sumC, c); sumTok = add(sumTok, tokensFor(c));
            const live = h.state(ADDR, 'c:' + b);
            if (m.rec[b]) {
                assert.ok(live !== null && eqExact(live, m.rec[b]), tag + ' ' + where + ': record of ' + b + ' is ' + live + ', model ' + m.rec[b]);
                outC = add(outC, m.rec[b]); outTok = add(outTok, tokensFor(m.rec[b]));
            } else {
                assert.strictEqual(live, null, tag + ' ' + where + ': stale record for ' + b);
            }
        }
        assert.ok(eqExact(raised, sumC), tag + ' ' + where + ': raised ' + raised + ' != sum of records ' + sumC);
        assert.ok(eqExact(h.state(ADDR, 'allocated'), sumTok), tag + ' ' + where + ': allocated != sum of floored records');
        assert.ok(bn(raised).lte(bn(o.hard)), tag + ' ' + where + ': raised past hard cap');
        // Pay custody: every accounted payment plus pending orphans, less what left by refund or withdraw.
        assert.ok(eqExact(bal(h, ADDR, PAY), sub(add(raised, m.orphan), m.paidOut)), tag + ' ' + where + ': PAY custody mismatch');
        // Sale custody: the minted inventory less claims and burns, always backing every live record on success.
        assert.ok(eqExact(bal(h, ADDR, SALE), sub(sub(minted, m.claimed), m.burned)), tag + ' ' + where + ': SALE custody mismatch');
        if (status === 'SUCCESS') assert.ok(bn(bal(h, ADDR, SALE)).gte(bn(outTok)), tag + ' ' + where + ': claims under-backed');
        if (status === 'FAILED') assert.ok(bn(bal(h, ADDR, PAY)).gte(bn(outC)), tag + ' ' + where + ': refunds under-backed');
    };

    const doBuy = (b, amt) => {
        const prior = m.rec[b] || '0';
        const r = buy(h, b, amt);
        if (r.success) {
            const change = sentTo(r, b, PAY);
            const c = sub(add(add(prior, m.orphan), amt), change);
            m.orphan = '0';
            if (bn(c).isZero()) delete m.rec[b]; else { m.rec[b] = c; m.everRec[b] = c; }
            // Minimality: one pay base unit less would buy fewer whole sale units.
            if (!bn(c).isZero())
                assert.ok(bn(tokensFor(sub(c, uPay))).lt(bn(tokensFor(c))), tag + ': record ' + c + ' is not the minimal price of its tokens');
            else assert.ok(bn(prior).isZero(), tag + ': a prior record was dropped');
        } else {
            m.orphan = add(m.orphan, amt);
            assert.ok(/sale not open|sale closed|hard cap exceeded|no payment received/.test(r.error), tag + ': unexpected buy error ' + r.error);
        }
        return r;
    };

    for (let step = 0; step < 40; step++) {
        const roll = R.next();
        const who = R.pick(ACTORS);
        const status = h.state(ADDR, 'status');
        if (roll < 0.4) {
            doBuy(R.pick(BUYERS), randomPay(R, o.payDec));
        } else if (roll < 0.45) {
            const amt = randomPay(R, o.payDec);
            h.deposit(R.pick(BUYERS), ADDR, PAY, amt);
            m.orphan = add(m.orphan, amt);
        } else if (roll < 0.55) {
            h.mineBlock(R.int(1, 6));
        } else if (roll < 0.65) {
            const r = call(h, 'finalize', who);
            const atCap = bn(h.state(ADDR, 'raised')).gte(bn(o.hard));
            const expired = h.ledger.blockHeight >= parseInt(h.state(ADDR, 'deadline'), 10);
            assert.strictEqual(r.success, status === 'OPEN' && (atCap || expired), tag + ': finalize outcome');
            if (r.success) {
                assert.ok(!m.finalized, tag + ': finalized twice');
                m.finalized = true;
                assert.strictEqual(h.state(ADDR, 'status'), bn(h.state(ADDR, 'raised')).gte(bn(o.soft)) ? 'SUCCESS' : 'FAILED');
            }
        } else if (roll < 0.75) {
            const r = call(h, 'claim', who);
            assert.strictEqual(r.success, status === 'SUCCESS' && !!m.rec[who], tag + ': claim outcome for ' + who);
            if (r.success) {
                const got = sentTo(r, who, SALE);
                assert.ok(eqExact(got, tokensFor(m.rec[who])), tag + ': claim paid ' + got);
                m.claimed = add(m.claimed, got);
                delete m.rec[who];
            }
        } else if (roll < 0.85) {
            const r = call(h, 'refund', who);
            assert.strictEqual(r.success, status === 'FAILED' && !!m.rec[who], tag + ': refund outcome for ' + who);
            if (r.success) {
                assert.ok(eqExact(sentTo(r, who, PAY), m.rec[who]), tag + ': refund amount');
                m.paidOut = add(m.paidOut, m.rec[who]);
                delete m.rec[who];
            }
        } else if (roll < 0.92) {
            const r = call(h, 'withdraw', who);
            assert.strictEqual(r.success, status === 'SUCCESS' && who === OWNER && !m.withdrawn, tag + ': withdraw outcome');
            if (r.success) {
                m.withdrawn = true;
                assert.ok(eqExact(sentTo(r, OWNER, PAY), h.state(ADDR, 'raised')), tag + ': withdraw amount');
                m.paidOut = add(m.paidOut, h.state(ADDR, 'raised'));
            }
        } else {
            const before = bal(h, ADDR, SALE);
            const r = call(h, 'burnUnsold', who);
            assert.strictEqual(r.success, status !== 'OPEN' && !m.burnedOnce, tag + ': burnUnsold outcome');
            if (r.success) { m.burnedOnce = true; m.burned = add(m.burned, sub(before, bal(h, ADDR, SALE))); }
        }
        check('step ' + step);
    }

    // Drive to completion: every record settles and no sale token is left behind.
    h.mineBlock(DURATION + 1);
    if (h.state(ADDR, 'status') === 'OPEN') assert.ok(call(h, 'finalize', 'stranger').success, tag + ': final finalize');
    const status = h.state(ADDR, 'status');
    for (const b of BUYERS) if (m.rec[b]) {
        const r = call(h, status === 'SUCCESS' ? 'claim' : 'refund', b);
        assert.ok(r.success, tag + ': settle ' + b + ': ' + r.error);
        if (status === 'SUCCESS') m.claimed = add(m.claimed, sentTo(r, b, SALE));
        else m.paidOut = add(m.paidOut, m.rec[b]);
        delete m.rec[b];
    }
    if (status === 'SUCCESS' && !m.withdrawn) {
        assert.ok(call(h, 'withdraw', OWNER).success, tag + ': final withdraw');
        m.paidOut = add(m.paidOut, h.state(ADDR, 'raised'));
        m.withdrawn = true;
    }
    if (!m.burnedOnce) {
        const before = bal(h, ADDR, SALE);
        assert.ok(call(h, 'burnUnsold', 'stranger').success, tag + ': final burn');
        m.burned = add(m.burned, sub(before, bal(h, ADDR, SALE)));
    }
    check('final');
    assert.ok(bn(bal(h, ADDR, SALE)).isZero(), tag + ': sale inventory left after claims and burn: ' + bal(h, ADDR, SALE));
    assert.ok(eqExact(bal(h, ADDR, PAY), m.orphan), tag + ': PAY left beyond orphans');
    for (const b of BUYERS) assert.ok(eqExact(bal(h, b, SALE), status === 'SUCCESS' ? tokensFor(m.everRec[b] || '0') : '0'),
        tag + ': ' + b + ' holds the wrong sale amount');
    return h;
}

(available ? describe : describe.skip)('crowdsale invariants (in-process)', function () {
    const STD = { payDec: 8, saleDec: 8, rate: '10', soft: '100', hard: '200' };

    it('conservation, accounting and lifecycle across seeded random call sequences', function () {
        const seen = {};
        for (let seed = 1; seed <= 150; seed++) {
            const st = runSeed(seed).state(ADDR, 'status');
            seen[st] = (seen[st] || 0) + 1;
        }
        // Coverage: both outcomes are reached.
        for (const st of ['SUCCESS', 'FAILED']) assert.ok(seen[st] >= 10, 'too few runs ending ' + st + ': ' + JSON.stringify(seen));
    });

    it('determinism: the same seeded sequence yields the same ledger and state', function () {
        for (const seed of [3, 17, 42]) {
            const a = runSeed(seed).ledger.snapshot();
            const b = runSeed(seed).ledger.snapshot();
            assert.deepStrictEqual(a, b, 'seed ' + seed);
        }
    });

    it('lifecycle: no double claim, refund, withdraw, finalize or burn', function () {
        const h = setup(STD);
        assert.ok(buy(h, 'b1', '120').success);
        h.mineBlock(DURATION);
        assert.ok(call(h, 'finalize', 'stranger').success);
        assert.ok(!call(h, 'finalize', 'stranger').success);
        assert.ok(call(h, 'claim', 'b1').success);
        assert.ok(!call(h, 'claim', 'b1').success);
        assert.ok(!call(h, 'refund', 'b1').success);
        assert.ok(call(h, 'withdraw', OWNER).success);
        assert.ok(!call(h, 'withdraw', OWNER).success);
        assert.ok(call(h, 'burnUnsold', 'stranger').success);
        assert.ok(!call(h, 'burnUnsold', 'stranger').success);
        assert.strictEqual(bal(h, 'b1', SALE), '1200');
        assert.strictEqual(bal(h, ADDR, SALE), '0');
        assert.ok(!buy(h, 'b2', '1').success, 'buy after finalize');
    });

    it('authorization: only the owner withdraws; claim and refund are status gated', function () {
        const h = setup(STD);
        assert.ok(buy(h, 'b1', '150').success);
        assert.ok(!call(h, 'finalize', 'b1').success, 'finalize before deadline and below cap');
        assert.ok(!call(h, 'burnUnsold', 'b1').success, 'burn while open');
        h.mineBlock(DURATION);
        assert.ok(!buy(h, 'b2', '1').success, 'buy at deadline');
        assert.ok(call(h, 'finalize', 'b2').success);
        for (const c of ['b1', 'b2', 'stranger']) assert.ok(!call(h, 'withdraw', c).success, 'withdraw by ' + c);
        assert.ok(!call(h, 'refund', 'b1').success, 'refund on success');
        assert.ok(!call(h, 'claim', 'b2').success, 'claim without a record');
    });

    it('caps compare exactly: one base unit past the hard cap reverts, one short of the soft cap fails', function () {
        const h = setup(STD);
        assert.ok(buy(h, 'b1', '199.99999999').success);
        const r = buy(h, 'b2', '0.00000002');
        assert.ok(!r.success && /hard cap/.test(r.error), r.error);
        const k = setup(STD);
        assert.ok(buy(k, 'b1', '199.99999999').success);
        assert.ok(!call(k, 'finalize', 'stranger').success, 'early close one base unit below the hard cap');
        assert.ok(buy(k, 'b3', '0.00000001').success);
        assert.ok(call(k, 'finalize', 'stranger').success, 'early close at the exact hard cap');

        const g = setup(STD);
        assert.ok(buy(g, 'b1', '99.99999999').success);
        g.mineBlock(DURATION);
        assert.ok(call(g, 'finalize', 'stranger').success);
        assert.strictEqual(g.state(ADDR, 'status'), 'FAILED');
        assert.ok(call(g, 'refund', 'b1').success);
        assert.strictEqual(bal(g, 'b1', PAY), SEED_PAY);
    });

    it('boundaries: one base unit buys, dust below one sale unit is returned in full', function () {
        const h = setup(STD);
        assert.ok(buy(h, 'b1', '0.00000001').success);
        assert.strictEqual(h.state(ADDR, 'c:b1'), '0.00000001');
        const g = setup({ payDec: 8, saleDec: 0, rate: '0.5', soft: '1', hard: '1000' });
        const r = buy(g, 'b1', '2.00000001');
        assert.ok(r.success, r.error);
        assert.strictEqual(sentTo(r, 'b1', PAY), '0.00000001');
        assert.strictEqual(g.state(ADDR, 'c:b1'), '2');
        const d = buy(g, 'b2', '1');
        assert.ok(d.success && sentTo(d, 'b2', PAY) === '1' && g.state(ADDR, 'c:b2') === null);
    });

    it('huge values: a 1e30 hard cap at a 1e10 rate conserves exactly', function () {
        const big = { payDec: 8, saleDec: 8, rate: '10000000000', soft: '1', hard: '1000000000000000000000000000000' };
        const h = setup(big);
        h.seedBalance('b1', PAY, '999999999999999999999999999999.99999999');
        assert.ok(buy(h, 'b1', '999999999999999999999999999999.99999999').success);
        assert.ok(buy(h, 'b2', '0.00000001').success);
        assert.ok(call(h, 'finalize', 'stranger').success);
        assert.ok(call(h, 'claim', 'b1').success && call(h, 'claim', 'b2').success);
        assert.ok(call(h, 'burnUnsold', 'stranger').success);
        assert.strictEqual(bal(h, ADDR, SALE), '0');
        assert.strictEqual(bal(h, 'b1', SALE), '9999999999999999999999999999999999999900');
        assert.strictEqual(bal(h, 'b2', SALE), '100');
    });

    it('constructor boundaries revert cleanly', function () {
        const bad = [
            ['0', '100', '200', '8'], ['10', '0', '200', '8'], ['10', '200', '100', '8'], ['1e1', '100', '200', '8'],
            ['-1', '100', '200', '8'], ['10', '100', 'Infinity', '8'], ['10', '100', '200', '19'], ['10', '100', '200', '08']
        ];
        for (const p of bad) {
            const h = new Harness();
            const r = h.deploy({ code: CODE, deployer: OWNER, contractAddress: ADDR,
                params: [OWNER, PAY, SALE, p[0], p[1], p[2], String(DURATION), p[3]] });
            assert.ok(!r.success, p.join(','));
        }
        for (const d of ['0', '1000001', '1e3', ' 5', '5.0']) {
            const h = new Harness();
            const r = h.deploy({ code: CODE, deployer: OWNER, contractAddress: ADDR,
                params: [OWNER, PAY, SALE, '10', '100', '200', d, '8'] });
            assert.ok(!r.success, 'duration ' + d);
        }
    });

    // Regression: buy() tested the contribution with the tolerant gt, which reads any amount up to
    // 1e-15 as zero, so on an 18-decimal pay tick a real payment reverted as 'no payment
    // received' and, because a BATCH is not atomic, its DEPOSIT was left for the next buyer.
    it('a sub-1e-15 payment on an 18-decimal pay tick is attributed to its payer', function () {
        const h = setup({ payDec: 18, saleDec: 8, rate: '10000000000', soft: '1', hard: '1' });
        const r = buy(h, 'b1', '0.0000000000000001');
        assert.ok(r.success, 'buy reverted: ' + r.error);
        assert.strictEqual(h.state(ADDR, 'c:b1'), '0.0000000000000001');
        assert.ok(buy(h, 'b2', '0.5').success);
        assert.strictEqual(h.state(ADDR, 'c:b2'), '0.5', 'b2 absorbed another buyer\'s deposit');
    });
});
