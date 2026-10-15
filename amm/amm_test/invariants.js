// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// amm_test/invariants.js: seeded invariant tests for amm.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness: BaseHarness, rng, bn } = require('../../test/helpers/harness.js');
// The shared harness picks its tolerance band with mathjs M.max, which is itself
// tolerant, so for operands below about 1e-15 it returns 1e-12 x larger instead of
// the documented max(1e-12 x larger, 1e-15) floor. This subclass swaps in the
// documented band (Decimal comparisons are exact) and leaves everything else as is.
function documentedCompare(a, b) {
    const x = bn(a), y = bn(b);
    const larger = x.abs().gt(y.abs()) ? x.abs() : y.abs();
    const rel = larger.times('1e-12');
    const floor = bn('1e-15');
    const band = rel.gt(floor) ? rel : floor;
    if (x.minus(y).abs().lte(band)) return 0;
    return x.gt(y) ? 1 : -1;
}
class Harness extends BaseHarness {
    makeApi(addr, params, caller, actions) {
        const api = super.makeApi(addr, params, caller, actions);
        Object.assign(api.math, {
            gt: (a, b) => documentedCompare(a, b) > 0,
            gte: (a, b) => documentedCompare(a, b) >= 0,
            lt: (a, b) => documentedCompare(a, b) < 0,
            lte: (a, b) => documentedCompare(a, b) <= 0,
            eq: (a, b) => documentedCompare(a, b) === 0,
            compare: (a, b) => documentedCompare(a, b)
        });
        return api;
    }
}


const CODE = fs.readFileSync(path.join(__dirname, '..', 'amm.js'), 'utf8');
const ADDR = 'C:BTC:1';
const A = 'AAA', B = 'BBB', LP = 'AAABBBLP';
const LP_MAX = '99999999999999999999';
const LOCKED = '0.001';
const ACTORS = ['lp1', 'lp2', 'trader', 'stranger'];
const SEED = '1000000';

// Exact base-unit integer of a fixed-notation decimal on a `dec` grid; throws when
// the value carries more fraction digits than the grid allows.
function units(v, dec) {
    let s = String(v);
    const neg = s.charAt(0) === '-';
    if (neg) s = s.substring(1);
    const dot = s.indexOf('.');
    const ip = dot < 0 ? s : s.substring(0, dot);
    let fp = dot < 0 ? '' : s.substring(dot + 1);
    fp = fp.replace(/0+$/, '');
    if (fp.length > dec) throw new Error('off-grid value ' + v + ' for ' + dec + ' decimals');
    const n = BigInt((ip || '0') + fp.padEnd(dec, '0'));
    return neg ? -n : n;
}
function fromUnits(n, dec) {
    const s = n.toString().padStart(dec + 1, '0');
    if (dec === 0) return s;
    const out = s.substring(0, s.length - dec) + '.' + s.substring(s.length - dec);
    return out.replace(/\.?0+$/, '');
}

function setup(decA, decB) {
    const h = new Harness();
    h.ledger.setTokenDecimals(A, decA);
    h.ledger.setTokenDecimals(B, decB);
    for (const u of ACTORS) { h.seedBalance(u, A, SEED); h.seedBalance(u, B, SEED); }
    const r = h.deploy({ code: CODE, deployer: 'lp1', contractAddress: ADDR, params: [A, B, LP] });
    assert.ok(r.success, r.error);
    return h;
}
const st = (h, k) => h.state(ADDR, k);
const call = (h, who, method, params) => h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: who });
function addLiq(h, who, a, b) { h.deposit(who, ADDR, A, a); h.deposit(who, ADDR, B, b); return call(h, who, 'addLiquidity'); }
function swap(h, who, tick, amt, minOut) { h.deposit(who, ADDR, tick, amt); return call(h, who, 'swap', [tick, minOut === undefined ? '0' : minOut]); }
function remove(h, who, lp) { h.deposit(who, ADDR, LP, lp); return call(h, who, 'removeLiquidity'); }

// Every accounting invariant the pool promises, checked exactly in base units.
function checkInvariants(h, decA, decB, tag) {
    const L = h.ledger;
    assert.strictEqual(units(L.total(A), decA), units(SEED, decA) * BigInt(ACTORS.length), tag + ': A supply drift');
    assert.strictEqual(units(L.total(B), decB), units(SEED, decB) * BigInt(ACTORS.length), tag + ': B supply drift');
    const rA = units(st(h, 'reserveA'), decA), rB = units(st(h, 'reserveB'), decB);
    assert.ok(units(L.getBalance(ADDR, A), decA) >= rA, tag + ': reserveA exceeds custody');
    assert.ok(units(L.getBalance(ADDR, B), decB) >= rB, tag + ': reserveB exceeds custody');
    assert.ok(rA >= 0n && rB >= 0n, tag + ': negative reserve');
    const ts = units(st(h, 'totalShares'), 8);
    const inv = units(st(h, 'lpInventory'), 8);
    const poolLp = units(L.getBalance(ADDR, LP), 8);
    assert.ok(poolLp >= inv, tag + ': LP inventory exceeds LP custody');
    let held = 0n;
    for (const u of ACTORS) held += units(L.getBalance(u, LP), 8);
    const pending = poolLp - inv;
    if (ts > 0n) {
        assert.ok(rA > 0n && rB > 0n, tag + ': a reserve drained to zero with shares outstanding');
        assert.strictEqual(held + pending, ts - units(LOCKED, 8), tag + ': LP outstanding != totalShares - locked');
    } else {
        assert.strictEqual(held + pending, 0n, tag + ': LP outstanding with zero totalShares');
    }
    assert.strictEqual(units(L.total(LP), 8), units(L.tokens[LP].SUPPLY, 8), tag + ': LP supply record drift');
    assert.strictEqual(poolLp + held, units(L.tokens[LP].SUPPLY, 8), tag + ': LP held outside pool and actors');
    assert.ok(units(L.tokens[LP].SUPPLY, 8) <= units(LP_MAX, 8), tag + ': LP supply above cap');
    return { rA: rA, rB: rB, ts: ts };
}

function randAmount(R, dec, maxWhole) {
    const whole = R.int(0, maxWhole);
    const frac = dec > 0 ? String(R.int(0, Math.pow(10, Math.min(dec, 6)) - 1)).padStart(Math.min(dec, 6), '0') : '';
    const s = dec > 0 ? whole + '.' + frac : String(whole);
    return fromUnits(units(s, dec), dec);
}

(available ? describe : describe.skip)('amm invariants (in-process)', function () {
    const CONFIGS = [[8, 8], [0, 8], [18, 2]];

    it('conservation, custody >= reserves, LP bookkeeping and value per share across seeded random sequences', function () {
        for (const [decA, decB] of CONFIGS) {
            for (let seed = 1; seed <= 40; seed++) {
                const R = rng(seed * 7 + decA);
                const h = setup(decA, decB);
                let prev = checkInvariants(h, decA, decB, 'seed ' + seed + ' init');
                for (let step = 0; step < 40; step++) {
                    const who = R.pick(ACTORS);
                    const op = R.int(0, 9);
                    let r = null, kind = 'other';
                    if (op <= 2) {
                        r = addLiq(h, who, randAmount(R, decA, R.pick([1, 50, 5000])), randAmount(R, decB, R.pick([1, 50, 5000])));
                        kind = 'add';
                    } else if (op <= 6) {
                        const tick = R.pick([A, B]);
                        const dec = tick === A ? decA : decB;
                        const bal = h.ledger.getBalance(who, tick);
                        const amt = randAmount(R, dec, R.pick([0, 10, 2000]));
                        if (units(amt, dec) > 0n && units(amt, dec) <= units(bal, dec)) r = swap(h, who, tick, amt, R.next() < 0.2 ? randAmount(R, 8, 100) : '0');
                        kind = 'swap';
                    } else if (op <= 8) {
                        const lpBal = units(h.ledger.getBalance(who, LP), 8);
                        if (lpBal > 0n) {
                            const part = R.next() < 0.3 ? lpBal : lpBal * BigInt(R.int(1, 1000)) / 1000n;
                            if (part > 0n) r = remove(h, who, fromUnits(part, 8));
                        } else {
                            r = call(h, who, 'removeLiquidity');
                        }
                        kind = 'remove';
                    } else {
                        // Stray donation outside a call, then a bare call by someone else.
                        if (R.next() < 0.5) h.deposit(who, ADDR, R.pick([A, B]), '1');
                        r = call(h, R.pick(ACTORS), R.pick(['swap', 'addLiquidity', 'removeLiquidity']), [R.pick([A, B, LP]), '0']);
                    }
                    const tag = 'cfg ' + decA + '/' + decB + ' seed ' + seed + ' step ' + step + ' ' + kind;
                    const now = checkInvariants(h, decA, decB, tag);
                    if (r && r.success && prev.ts > 0n) {
                        // sqrt(k) per share never falls: k1 * ts0^2 >= k0 * ts1^2.
                        const lhs = now.rA * now.rB * prev.ts * prev.ts;
                        const rhs = prev.rA * prev.rB * now.ts * now.ts;
                        assert.ok(lhs >= rhs, tag + ': value per LP share fell');
                        if (kind === 'swap') assert.ok(now.rA * now.rB >= prev.rA * prev.rB, tag + ': k decreased on swap');
                    }
                    prev = now;
                }
            }
        }
    });

    it('every emitted quantity is already on its tick grid (no half-up re-rounding)', function () {
        for (const [decA, decB] of CONFIGS) {
            const R = rng(99 + decA);
            const h = setup(decA, decB);
            const decOf = { [A]: decA, [B]: decB, [LP]: 8 };
            assert.ok(addLiq(h, 'lp1', randAmount(R, decA, 3000) || '1', randAmount(R, decB, 3000) || '1').success);
            for (let i = 0; i < 150; i++) {
                const who = R.pick(ACTORS);
                const tick = R.pick([A, B]);
                const amt = randAmount(R, tick === A ? decA : decB, 300);
                let r;
                if (R.next() < 0.7) { if (units(amt, decOf[tick]) === 0n) continue; r = swap(h, who, tick, amt); } else {
                    const lp = units(h.ledger.getBalance(who, LP), 8);
                    if (lp === 0n) continue;
                    r = remove(h, who, fromUnits(lp / 3n || lp, 8));
                }
                if (!r.success) continue;
                for (const a of r.actions) {
                    assert.strictEqual(units(a.params.quantity, decOf[a.params.tick]), units(a.settled || a.params.quantity, decOf[a.params.tick]),
                        'emission off grid: ' + JSON.stringify(a.params));
                }
            }
        }
    });

    it('first deposit boundary: 1 base unit each and exactly MINIMUM_LIQUIDITY revert; one LP unit above mints one unit', function () {
        let h = setup(8, 8);
        let r = addLiq(h, 'lp1', '0.00000001', '0.00000001');
        assert.ok(!r.success && /insufficient liquidity minted/.test(r.error), r.error);
        h = setup(8, 8);
        r = addLiq(h, 'lp1', '0.001', '0.001');
        assert.ok(!r.success && /insufficient liquidity minted/.test(r.error), r.error);
        h = setup(8, 8);
        r = addLiq(h, 'lp1', '0.00100001', '0.00100001');
        assert.ok(r.success, r.error);
        assert.strictEqual(h.ledger.getBalance('lp1', LP), '0.00000001');
        checkInvariants(h, 8, 8, 'min+1');
    });

    it('error paths: zero deposit, one-sided deposit, LP or foreign tick as tokenIn, swap on an empty pool', function () {
        const h = setup(8, 8);
        let r = call(h, 'trader', 'swap', [A, '0']);
        assert.ok(!r.success && /no liquidity/.test(r.error), r.error);
        r = call(h, 'lp1', 'addLiquidity');
        assert.ok(!r.success && /must deposit both tokens/.test(r.error), r.error);
        h.deposit('lp1', ADDR, A, '10');
        r = call(h, 'lp1', 'addLiquidity');
        assert.ok(!r.success && /must deposit both tokens/.test(r.error), r.error);
        h.deposit('lp1', ADDR, B, '10');
        assert.ok(call(h, 'lp1', 'addLiquidity').success);
        for (const t of [LP, 'XCHAIN', '', null]) {
            r = call(h, 'trader', 'swap', [t, '0']);
            assert.ok(!r.success && /tokenIn not in pair/.test(r.error), String(t));
        }
        r = call(h, 'trader', 'swap', [A, '0']);
        assert.ok(!r.success && /no input received/.test(r.error), r.error);
        r = call(h, 'trader', 'removeLiquidity');
        assert.ok(!r.success && /must deposit LP shares/.test(r.error), r.error);
        checkInvariants(h, 8, 8, 'errors');
    });

    it('removeLiquidity cannot be repeated without a new LP deposit, and burns exactly the deposit', function () {
        const h = setup(8, 8);
        assert.ok(addLiq(h, 'lp1', '1000', '1000').success);
        const r = remove(h, 'lp1', '999.999');
        assert.ok(r.success, r.error);
        assert.strictEqual(r.actions.find((a) => a.action === 'DESTROY').params.quantity, '999.999');
        const again = call(h, 'lp1', 'removeLiquidity');
        assert.ok(!again.success && /must deposit LP shares/.test(again.error), again.error);
        assert.strictEqual(st(h, 'totalShares'), '0.001');
        assert.ok(units(st(h, 'reserveA'), 8) > 0n && units(st(h, 'reserveB'), 8) > 0n);
        checkInvariants(h, 8, 8, 'double remove');
    });

    it('payouts go to the caller only; a stranger cannot redeem LP it does not deposit', function () {
        const h = setup(8, 8);
        assert.ok(addLiq(h, 'lp1', '1000', '1000').success);
        const before = h.ledger.getBalance('stranger', A);
        const r = call(h, 'stranger', 'removeLiquidity');
        assert.ok(!r.success);
        assert.strictEqual(h.ledger.getBalance('stranger', A), before);
        const s = swap(h, 'trader', A, '10');
        assert.ok(s.success);
        for (const a of s.actions) assert.strictEqual(a.params.destination, 'trader');
    });

    it('minOut is enforced to the base unit', function () {
        const probe = setup(8, 8);
        assert.ok(addLiq(probe, 'lp1', '1000', '1000').success);
        const out = swap(probe, 'trader', A, '10').result;
        const plusOne = fromUnits(units(out, 8) + 1n, 8);
        let h = setup(8, 8);
        assert.ok(addLiq(h, 'lp1', '1000', '1000').success);
        const r = swap(h, 'trader', A, '10', plusOne);
        assert.ok(!r.success && /slippage/.test(r.error), r.error);
        h = setup(8, 8);
        assert.ok(addLiq(h, 'lp1', '1000', '1000').success);
        assert.strictEqual(swap(h, 'trader', A, '10', out).result, out);
        for (const bad of ['abc', 'Infinity', 'NaN']) {
            h = setup(8, 8);
            assert.ok(addLiq(h, 'lp1', '1000', '1000').success);
            assert.ok(!swap(h, 'trader', A, '10', bad).success, bad);
        }
    });

    it('huge reserves and dust inputs: 1 base unit into a deep pool reverts, a huge input never drains the out reserve', function () {
        const big = '100000000000000000';
        const h = new Harness();
        h.ledger.setTokenDecimals(A, 8);
        h.ledger.setTokenDecimals(B, 8);
        for (const u of ['lp1', 'trader']) { h.seedBalance(u, A, '1000000000000000000'); h.seedBalance(u, B, '1000000000000000000'); }
        assert.ok(h.deploy({ code: CODE, deployer: 'lp1', contractAddress: ADDR, params: [A, B, LP] }).success);
        assert.ok(addLiq(h, 'lp1', big, big).success);
        const dust = swap(h, 'trader', A, '0.00000001');
        assert.ok(!dust.success && /insufficient output/.test(dust.error), dust.error);
        const k0 = units(st(h, 'reserveA'), 8) * units(st(h, 'reserveB'), 8);
        const r = swap(h, 'trader', B, '800000000000000000');
        assert.ok(r.success, r.error);
        const rA = units(st(h, 'reserveA'), 8), rB = units(st(h, 'reserveB'), 8);
        assert.ok(rA > 0n && rA * rB >= k0);
        assert.ok(units(h.ledger.getBalance(ADDR, A), 8) >= rA);
    });

    it('constructor: identical ticks and an LP tick already issued revert', function () {
        for (const p of [[A, A, LP], [A, B, A], [A, B, B], [A, '', LP], [A, B, '']]) {
            const h = new Harness();
            assert.ok(!h.deploy({ code: CODE, deployer: 'lp1', contractAddress: ADDR, params: p }).success, p.join(','));
        }
        const h = new Harness();
        h.ledger.tokens[LP] = { DECIMALS: 8, SUPPLY: '0', OWNER: 'someone' };
        assert.ok(!h.deploy({ code: CODE, deployer: 'lp1', contractAddress: ADDR, params: [A, B, LP] }).success);
    });

    it('does not read wall-clock time or randomness (sandbox stubs throw)', function () {
        const h = setup(8, 8);
        assert.ok(addLiq(h, 'lp1', '1000', '1000').success);
        assert.ok(swap(h, 'trader', B, '3.3').success);
        assert.ok(remove(h, 'lp1', '1').success);
        assert.ok(call(h, 'x', 'info').success);
    });
});
