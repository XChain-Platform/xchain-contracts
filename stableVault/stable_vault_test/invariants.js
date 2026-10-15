// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// stable_vault_test/invariants.js: seeded invariant tests for stableVault.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness: BaseHarness, rng, bn } = require('../../test/inproc/harness.js');
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


const CODE = fs.readFileSync(path.join(__dirname, '..', 'stableVault.js'), 'utf8');
const ADDR = 'C:BTC:1';
const COLL = 'GOLD', STABLE = 'DUSD', PAIR = 'GOLD/USD';
const RATIO = '150', BONUS = '10', MAXAGE = '10';
const ACTORS = ['alice', 'bob', 'carol', 'liq'];
const SEED = '1000';
const PRICE_DEC = 18;

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
    return (s.substring(0, s.length - dec) + '.' + s.substring(s.length - dec)).replace(/\.?0+$/, '');
}

function setPrice(h, price, age) {
    const a = age || 0;
    h.ledger.oracle.prices[PAIR] = { price: String(price), roundNumber: 1, timestamp: h.ledger.blockTimestamp - a };
    h.ledger.oracle.snapshotAge = a;
}
function setup(collDec, stableDec) {
    const h = new Harness();
    h.ledger.setTokenDecimals(COLL, collDec);
    for (const u of ACTORS) h.seedBalance(u, COLL, SEED);
    const r = h.deploy({ code: CODE, deployer: 'alice', contractAddress: ADDR,
        params: [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE, String(stableDec)] });
    assert.ok(r.success, r.error);
    setPrice(h, '100');
    return h;
}
const call = (h, who, method, params) => h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: who });
const vault = (h, who, f) => h.state(ADDR, 'v:' + who + ':' + f) || '0';
function depositColl(h, who, q) { h.deposit(who, ADDR, COLL, q); return call(h, who, 'deposit'); }
function repay(h, who, q) { h.deposit(who, ADDR, STABLE, q); return call(h, who, 'repay'); }
function liquidate(h, who, owner, q) { h.deposit(who, ADDR, STABLE, q); return call(h, who, 'liquidate', [owner]); }

// Exact ratio: coll * price * 100 >= debt * minRatioPct, in integers.
function healthyExact(h, who, collDec, stableDec, price) {
    const c = units(vault(h, who, 'coll'), collDec), d = units(vault(h, who, 'debt'), stableDec);
    if (d === 0n) return true;
    const p = units(price, PRICE_DEC);
    return c * p * 100n * (10n ** BigInt(stableDec)) >= d * BigInt(RATIO) * (10n ** BigInt(collDec)) * (10n ** BigInt(PRICE_DEC));
}

// Every accounting invariant the vault promises, checked exactly in base units.
function checkInvariants(h, collDec, stableDec, tag) {
    const L = h.ledger;
    assert.strictEqual(units(L.total(COLL), collDec), units(SEED, collDec) * BigInt(ACTORS.length), tag + ': collateral supply drift');
    let sumColl = 0n, sumDebt = 0n;
    for (const u of ACTORS) {
        const c = units(vault(h, u, 'coll'), collDec), d = units(vault(h, u, 'debt'), stableDec);
        assert.ok(c >= 0n && d >= 0n, tag + ': negative vault field for ' + u);
        assert.ok(d === 0n || c > 0n, tag + ': ' + u + ' carries debt ' + vault(h, u, 'debt') + ' against zero collateral');
        sumColl += c; sumDebt += d;
    }
    const tracked = units(h.state(ADDR, 'trackedColl'), collDec);
    assert.strictEqual(sumColl, tracked, tag + ': trackedColl != sum of vault collateral');
    assert.ok(units(L.getBalance(ADDR, COLL), collDec) >= tracked, tag + ': collateral custody below books');
    assert.strictEqual(units(h.state(ADDR, 'totalDebt'), stableDec), sumDebt, tag + ': totalDebt != sum of vault debts');
    assert.strictEqual(units(L.tokens[STABLE].SUPPLY, stableDec), sumDebt, tag + ': stable supply != outstanding debt');
    assert.strictEqual(units(L.total(STABLE), stableDec), sumDebt, tag + ': stable held != outstanding debt');
    assert.strictEqual(h.state(ADDR, 'trackedStable'), '0', tag + ': trackedStable moved');
}

function randAmt(R, dec, maxWhole) {
    const d = Math.min(dec, 6);
    const whole = R.int(0, maxWhole);
    const s = d > 0 ? whole + '.' + String(R.int(0, Math.pow(10, d) - 1)).padStart(d, '0') : String(whole);
    return fromUnits(units(s, dec), dec);
}

(available ? describe : describe.skip)('stableVault invariants (in-process)', function () {
    const CONFIGS = [[8, 8], [0, 2], [8, 18]];
    const PRICES = ['100', '80', '61', '1.5', '0.37', '2000', '100'];

    it('conservation, books == custody, supply == debt and ratio after borrow/withdraw across seeded random sequences', function () {
        for (const [collDec, stableDec] of CONFIGS) {
            for (let seed = 1; seed <= 40; seed++) {
                const R = rng(seed * 13 + stableDec);
                const h = setup(collDec, stableDec);
                let price = '100';
                // A well-funded liquidator so liquidations actually clear.
                assert.ok(depositColl(h, 'liq', '900').success);
                assert.ok(call(h, 'liq', 'borrow', ['30000']).success);
                for (let step = 0; step < 40; step++) {
                    let who = R.pick(ACTORS);
                    const op = R.int(0, 11);
                    let r = null, kind;
                    const debt = units(vault(h, who, 'debt'), stableDec);
                    let sBal = units(h.ledger.getBalance(who, STABLE), stableDec);
                    if (op <= 1) {
                        kind = 'deposit';
                        const q = randAmt(R, collDec, 200);
                        if (units(q, collDec) > 0n && units(q, collDec) <= units(h.ledger.getBalance(who, COLL), collDec)) r = depositColl(h, who, q);
                    } else if (op <= 3) {
                        kind = 'borrow';
                        // Aim at the ratio boundary half the time.
                        const c = units(vault(h, who, 'coll'), collDec);
                        const p = units(price, PRICE_DEC);
                        const maxDebt = c * p * 100n * (10n ** BigInt(stableDec)) / (BigInt(RATIO) * (10n ** BigInt(collDec)) * (10n ** BigInt(PRICE_DEC))) - debt;
                        const q = R.next() < 0.5 && maxDebt > 0n ? fromUnits(maxDebt + BigInt(R.int(-1, 1)), stableDec) : randAmt(R, stableDec, 3000);
                        r = call(h, who, 'borrow', [q]);
                    } else if (op <= 5) {
                        kind = 'repay';
                        let q = R.next() < 0.5 ? debt - BigInt(R.int(0, 2)) : sBal * BigInt(R.int(1, 100)) / 100n;
                        if (q > sBal) q = sBal;
                        if (q > 0n) r = repay(h, who, fromUnits(q, stableDec));
                    } else if (op <= 7) {
                        kind = 'withdraw';
                        const c = units(vault(h, who, 'coll'), collDec);
                        const q = R.next() < 0.4 ? c : c * BigInt(R.int(1, 100)) / 100n;
                        r = call(h, who, 'withdraw', [fromUnits(q, collDec)]);
                    } else if (op <= 8) {
                        kind = 'liquidate';
                        const indebted = ACTORS.filter((u) => units(vault(h, u, 'debt'), stableDec) > 0n);
                        const owner = indebted.length && R.next() < 0.8 ? R.pick(indebted) : R.pick(ACTORS);
                        const od = units(vault(h, owner, 'debt'), stableDec);
                        // Prefer the non-owner holding the most stable as the liquidator.
                        let best = who;
                        for (const u of ACTORS) if (u !== owner && units(h.ledger.getBalance(u, STABLE), stableDec) > units(h.ledger.getBalance(best, STABLE), stableDec)) best = u;
                        if (R.next() < 0.8) { who = best; sBal = units(h.ledger.getBalance(who, STABLE), stableDec); }
                        const wasHealthy = healthyExact(h, owner, collDec, stableDec, price);
                        if (od > 0n && sBal >= od && owner !== who) {
                            r = liquidate(h, who, owner, fromUnits(R.next() < 0.7 ? od : sBal, stableDec));
                            if (r.success) {
                                assert.ok(!wasHealthy, 'seed ' + seed + ': liquidated a healthy vault');
                                assert.strictEqual(vault(h, owner, 'debt'), '0');
                            }
                        } else {
                            r = call(h, who, 'liquidate', [owner]);
                        }
                    } else if (op <= 10) {
                        kind = 'price';
                        price = R.pick(PRICES);
                        setPrice(h, price, R.next() < 0.1 ? 50 : 0);
                        if (R.next() < 0.3) h.mineBlock(1, 5);
                    } else {
                        kind = 'stray';
                        h.deposit(who, ADDR, COLL, '1');
                        r = call(h, R.pick(ACTORS), R.pick(['deposit', 'repay', 'withdraw', 'borrow']), ['1']);
                    }
                    const tag = 'cfg ' + collDec + '/' + stableDec + ' seed ' + seed + ' step ' + step + ' ' + kind;
                    checkInvariants(h, collDec, stableDec, tag);
                    if (r && r.success && (kind === 'borrow' || kind === 'withdraw'))
                        assert.ok(healthyExact(h, who, collDec, stableDec, price), tag + ': vault below the minimum ratio after ' + kind);
                }
            }
        }
    });

    it('liquidate cannot settle twice; repay of a cleared vault refunds everything', function () {
        const h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        assert.ok(call(h, 'alice', 'borrow', ['200']).success);
        setPrice(h, '80');
        h.seedBalance('liq', STABLE, '400');
        h.ledger.tokens[STABLE].SUPPLY = '600';
        assert.ok(liquidate(h, 'liq', 'alice', '200').success);
        const again = liquidate(h, 'liq', 'alice', '200');
        assert.ok(!again.success && /vault has no debt/.test(again.error), again.error);
        // The stranded deposit from the reverted call is credited to the next repay caller.
        const r = call(h, 'bob', 'repay');
        assert.ok(r.success);
        assert.deepStrictEqual(r.actions.map((a) => [a.action, a.params.quantity, a.params.destination]), [['SEND', '200', 'bob']]);
    });

    it('authorization: borrow and withdraw touch only the caller vault; self-liquidation reverts', function () {
        const h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        assert.ok(!call(h, 'bob', 'withdraw', ['1']).success);
        const b = call(h, 'bob', 'borrow', ['1']);
        assert.ok(!b.success && /under-collateralized/.test(b.error), b.error);
        assert.ok(call(h, 'alice', 'borrow', ['200']).success);
        setPrice(h, '80');
        h.seedBalance('alice', STABLE, '200');
        h.ledger.tokens[STABLE].SUPPLY = '400';
        const s = liquidate(h, 'alice', 'alice', '200');
        assert.ok(!s.success && /own vault/.test(s.error), s.error);
        assert.strictEqual(vault(h, 'alice', 'coll'), '3');
        assert.strictEqual(vault(h, 'bob', 'coll'), '0');
    });

    it('boundaries: borrow exactly at the ratio passes, one base unit above reverts; zero and non-plain amounts revert', function () {
        const h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        const over = call(h, 'alice', 'borrow', ['200.00000001']);
        assert.ok(!over.success && /under-collateralized/.test(over.error), over.error);
        assert.ok(call(h, 'alice', 'borrow', ['200']).success);
        for (const bad of ['0', '0.000000001', '-1', '1e2', '', null, 'Infinity', '.5'])
            assert.ok(!call(h, 'alice', 'borrow', [bad]).success, 'borrow ' + bad);
        for (const bad of ['0', '0.000000001', '1e-8', '+1', '0x1'])
            assert.ok(!call(h, 'alice', 'withdraw', [bad]).success, 'withdraw ' + bad);
        const w = call(h, 'alice', 'withdraw', ['0.00000001']);
        assert.ok(!w.success && /under-collateralized/.test(w.error), w.error);
        checkInvariants(h, 8, 8, 'boundary');
    });

    it('a one-base-unit collateral deposit and huge supply-cap borrow stay consistent', function () {
        const h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '0.00000001').success);
        assert.strictEqual(vault(h, 'alice', 'coll'), '0.00000001');
        h.seedBalance('bob', COLL, '100000000');
        h.ledger.balances.bob[COLL] = String(Number(h.ledger.balances.bob[COLL]));
        setPrice(h, '1000');
        assert.ok(depositColl(h, 'bob', '10000000').success);
        // Supply cap 1e9: a borrow above it reverts as a whole, at it succeeds.
        assert.ok(!call(h, 'bob', 'borrow', ['1000000000.00000001']).success);
        assert.ok(call(h, 'bob', 'borrow', ['1000000000']).success);
        assert.ok(!call(h, 'alice', 'borrow', ['0.00000001']).success, 'mint beyond the cap reverts');
        assert.strictEqual(h.state(ADDR, 'totalDebt'), '1000000000');
    });

    it('stale or missing oracle blocks borrow, withdraw-with-debt and liquidate, never deposit or repay', function () {
        const h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        assert.ok(call(h, 'alice', 'borrow', ['100']).success);
        setPrice(h, '50', 11);
        assert.ok(!call(h, 'alice', 'borrow', ['1']).success);
        assert.ok(!call(h, 'alice', 'withdraw', ['1']).success);
        h.seedBalance('liq', STABLE, '100');
        h.ledger.tokens[STABLE].SUPPLY = '200';
        assert.ok(!liquidate(h, 'liq', 'alice', '100').success);
        assert.ok(depositColl(h, 'alice', '1').success);
        assert.ok(call(h, 'liq', 'repay').success, 'the stranded 100 refunds through repay');
        assert.ok(repay(h, 'alice', '100').success);
        assert.strictEqual(vault(h, 'alice', 'debt'), '0');
        delete h.ledger.oracle.prices[PAIR];
        assert.ok(call(h, 'alice', 'withdraw', ['4']).success, 'debt-free withdraw is oracle-free');
    });

    it('does not read wall-clock time or randomness (sandbox stubs throw)', function () {
        const h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        assert.ok(call(h, 'alice', 'borrow', ['100']).success);
        assert.ok(repay(h, 'alice', '50').success);
        assert.ok(call(h, 'alice', 'withdraw', ['1']).success);
        assert.ok(call(h, 'x', 'info').success && call(h, 'x', 'vault', ['alice']).success);
    });

    it('liquidation seizes debt * (100 + bonus) / (price * 100) on the grid, caps at collateral, and conserves', function () {
        let h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        assert.ok(call(h, 'alice', 'borrow', ['200']).success);
        assert.ok(depositColl(h, 'bob', '10').success);
        assert.ok(call(h, 'bob', 'borrow', ['300']).success);
        setPrice(h, '99.99');
        // owed = 200 * 110 / 9999 = 2.20022002200... floored to 2.20022002.
        let r = liquidate(h, 'bob', 'alice', '250');
        assert.ok(r.success, r.error);
        assert.deepStrictEqual(r.actions.map((a) => [a.action, a.params.tick, a.params.quantity]),
            [['DESTROY', STABLE, '200'], ['SEND', COLL, '2.20022002'], ['SEND', STABLE, '50']]);
        assert.strictEqual(vault(h, 'alice', 'coll'), '0.79977998');
        checkInvariants(h, 8, 8, 'liquidation');
        assert.ok(call(h, 'alice', 'withdraw', ['0.79977998']).success, 'owner keeps the leftover');
        // Bad debt: the seizure caps at the collateral and the whole debt still burns.
        h = setup(8, 8);
        assert.ok(depositColl(h, 'alice', '3').success);
        assert.ok(call(h, 'alice', 'borrow', ['200']).success);
        assert.ok(depositColl(h, 'bob', '10').success);
        assert.ok(call(h, 'bob', 'borrow', ['300']).success);
        setPrice(h, '1');
        r = liquidate(h, 'bob', 'alice', '200');
        assert.ok(r.success, r.error);
        assert.strictEqual(r.actions[1].params.quantity, '3');
        assert.strictEqual(vault(h, 'alice', 'coll'), '0');
        assert.strictEqual(vault(h, 'alice', 'debt'), '0');
        checkInvariants(h, 8, 8, 'bad debt');
    });

    it('the suite compare matches mathjs native tolerant compare (the documented band)', function () {
        const { M } = require('../../test/inproc/harness.js');
        const pairs = [['1e-18', '0'], ['1e-15', '0'], ['1.1e-15', '0'], ['0', '7.5e-16'], ['0', '1.5e-14'],
            ['300', '300.0000000001'], ['1', '1.000000000002'], ['150000000', '150000000.0001485'], ['-1', '1']];
        for (const [a, b] of pairs) assert.strictEqual(documentedCompare(a, b), M.compare(bn(a), bn(b)).toNumber(), a + ' vs ' + b);
    });

    // Regression: ratioOk() compared coll * price * 100 against debt * minRatioPct with the
    // tolerant math.gte, so a borrow (or withdraw) could leave the vault up to 1e-12
    // relative below the minimum ratio, and a vault that far under was not liquidatable.
    describe('the collateral ratio guard compares exactly', function () {
        function bigVault() {
            const h = setup(8, 8);
            h.seedBalance('alice', COLL, '500');
            setPrice(h, '1000');
            assert.ok(depositColl(h, 'alice', '1500').success);
            return h;
        }

        it('borrow above the exact ratio boundary reverts (1500 coll at 1000 caps debt at 1000000)', function () {
            const h = bigVault();
            const r = call(h, 'alice', 'borrow', ['1000000.00000099']);
            assert.ok(!r.success, 'borrow 99 base units above the minimum ratio succeeded, debt ' + vault(h, 'alice', 'debt'));
            assert.ok(/under-collateralized/.test(r.error), r.error);
            assert.ok(call(h, 'alice', 'borrow', ['1000000']).success, 'borrow exactly at the ratio');
        });

        it('withdraw that leaves the vault below the exact ratio reverts', function () {
            const h = bigVault();
            assert.ok(call(h, 'alice', 'borrow', ['999999.999994']).success);
            const r = call(h, 'alice', 'withdraw', ['0.00000001']);
            assert.ok(!r.success, 'withdraw left the vault below the minimum ratio');
        });
    });

    // Regression: with stableDecimals above 15 a debt at or below 1e-15 read as zero to the
    // tolerant math.gt, so withdraw() skipped the ratio check and liquidate() reported
    // 'vault has no debt': the vault could be emptied while debt remained, and a dust
    // debt could never be liquidated.
    describe('dust debt below the tolerant comparison floor still counts as debt', function () {
        function dustVault(borrowAmt) {
            const h = setup(8, 18);
            assert.ok(depositColl(h, 'alice', '3').success);
            assert.ok(call(h, 'alice', 'borrow', [borrowAmt]).success);
            assert.ok(repay(h, 'alice', '1').success);
            return h;
        }

        it('withdraw of all collateral reverts while 1e-18 of debt remains', function () {
            const h = dustVault('1.000000000000000001');
            assert.strictEqual(vault(h, 'alice', 'debt'), '0.000000000000000001');
            const r = call(h, 'alice', 'withdraw', ['3']);
            assert.ok(!r.success, 'withdraw of all collateral succeeded with debt ' + vault(h, 'alice', 'debt') + ' outstanding');
            assert.ok(/under-collateralized/.test(r.error), r.error);
            checkInvariants(h, 8, 18, 'dust-debt withdraw');
        });

        it('an under-water vault with 1e-15 of debt can be liquidated', function () {
            const h = dustVault('1.000000000000001');
            assert.ok(call(h, 'alice', 'withdraw', ['2.999']).success);
            setPrice(h, '0.000000000000002');
            h.seedBalance('liq', STABLE, '0.000000000000001');
            h.ledger.tokens[STABLE].SUPPLY = '0.000000000000002';
            const r = liquidate(h, 'liq', 'alice', '0.000000000000001');
            assert.ok(r.success, 'under-water dust-debt vault not liquidatable: ' + r.error);
            assert.strictEqual(vault(h, 'alice', 'debt'), '0');
        });
    });
});
