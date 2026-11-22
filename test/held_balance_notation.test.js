// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// held_balance_notation.test.js: a held balance in exponent text still pays out
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The indexer hands a contract its balances as String() of a decimal.js value,
// which is exponent text below 1e-6 ("5e-7") and from 1e21 ("1e+21"). Once the
// emission amount-format rule is armed, an emitted amount in that form reverts
// the whole EXECUTE, so a template that forwards its getBalance read as a SEND
// quantity strands sub-micro custody. The harness models both sides; these
// cases drive every exit that sweeps a held balance, and a source scan holds
// every template getBalance read inside an xchain.math call, whose result is
// always fixed notation.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { available, Harness, snapshotText, requirePlainAmount } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ADDR = 'C:BTC:1';
const TICK = 'TEST';
const suite = available ? describe : describe.skip;

// Sub-micro custody on an 18-decimal tick and on an 8-decimal tick (50 base units), plus
// the smallest amount a tolerant gt(amount, '0') constructor check still accepts.
const DUST = [{ decimals: 18, amount: '0.0000005' }, { decimals: 8, amount: '0.0000005' },
    { decimals: 18, amount: '0.000000000000002' }];

function call(h, method, caller, params) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller });
}

function ok(r, label) {
    assert.ok(r.success, label + ' reverted: ' + r.error);
    return r;
}

function assertPaid(h, r, payee, amount, label) {
    const sends = r.actions.filter((a) => a.action === 'SEND');
    assert.strictEqual(sends.length, 1, label + ': expected one SEND');
    assert.strictEqual(sends[0].params.destination, payee, label + ': wrong payee');
    assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '0', label + ': custody left behind');
    assert.strictEqual(h.ledger.getBalance(payee, TICK), amount, label + ': payee not paid in full');
}

// A harness holding `amount` of TICK at `decimals` in `holder`'s account.
function seeded(decimals, holder, amount) {
    const h = new Harness();
    h.ledger.setTokenDecimals(TICK, decimals);
    h.seedBalance(holder, TICK, amount);
    return h;
}

suite('held balance notation: the harness models the chain', function () {
    it('getBalance renders the snapshot as decimal.js String() does', function () {
        assert.strictEqual(snapshotText('0.0000005'), '5e-7');
        assert.strictEqual(snapshotText('0.000000000000000001'), '1e-18');
        assert.strictEqual(snapshotText('1000000000000000000000'), '1e+21');
        assert.strictEqual(snapshotText('0.000001'), '0.000001');
        assert.strictEqual(snapshotText('12.5'), '12.5');
    });

    it('an emitted amount that is not a plain decimal is refused', function () {
        for (const bad of ['5e-7', '1e+21', '1e2', '.5', '5.', '-1', '0x10', 'NaN', '1'.repeat(43)])
            assert.throws(() => requirePlainAmount('SEND', 'quantity', bad), /\(format\)/, bad);
        for (const good of ['0.0000005', '1000000000000000000000', '0', '12.5', '1'.repeat(42)])
            requirePlainAmount('SEND', 'quantity', good);
    });

    it('a contract forwarding its raw getBalance read reverts on sub-micro custody', function () {
        const raw = 'module.exports = { sweep: function (xchain) { xchain.emit.send({ destination: "out", ' +
            'tick: "' + TICK + '", quantity: xchain.getBalance(xchain.getContractAddress(), "' + TICK + '") }); } };';
        const h = seeded(18, ADDR, '0.0000005');
        h.deploy({ code: raw, deployer: 'd', contractAddress: ADDR });
        const r = call(h, 'sweep', 'd');
        assert.strictEqual(r.success, false, 'the raw sweep must fail as the armed indexer refuses it');
        assert.match(r.error, /SEND: invalid: quantity \(format\)/);
        assert.strictEqual(h.ledger.getBalance(ADDR, TICK), '0.0000005', 'revert must keep custody');
    });
});

suite('held balance notation: escrow', function () {
    const CODE = code('escrow/escrow.js');
    function deposited(d, terms) {
        const h = seeded(d.decimals, 'buyer', d.amount);
        ok(h.deploy({ code: CODE, deployer: 'buyer', contractAddress: ADDR,
            params: ['buyer', 'seller', 'arbiter', TICK, terms || d.amount, '3'] }), 'deploy');
        h.deposit('buyer', ADDR, TICK, d.amount);
        return h;
    }
    function settled(d, method, caller, blocks) {
        const h = deposited(d);
        ok(call(h, 'fund', 'buyer'), 'fund');
        if (blocks) h.mineBlock(blocks);
        return { h: h, r: ok(call(h, method, caller), method) };
    }
    for (const d of DUST) {
        const tag = d.amount + ' on a ' + d.decimals + '-decimal tick';
        it('release pays the seller ' + tag, function () {
            const s = settled(d, 'release', 'arbiter');
            assertPaid(s.h, s.r, 'seller', d.amount, 'release');
        });
        it('refund pays the buyer ' + tag, function () {
            const s = settled(d, 'refund', 'seller');
            assertPaid(s.h, s.r, 'buyer', d.amount, 'refund');
        });
        it('timeout pays the buyer ' + tag, function () {
            const s = settled(d, 'timeout', 'buyer', 3);
            assertPaid(s.h, s.r, 'buyer', d.amount, 'timeout');
        });
        it('cancel returns the INIT deposit ' + tag, function () {
            const h = deposited(d);
            assertPaid(h, ok(call(h, 'cancel', 'buyer'), 'cancel'), 'buyer', d.amount, 'cancel');
        });
    }
    it('cancel returns a one-base-unit INIT deposit on an 18-decimal tick', function () {
        const one = '0.000000000000000001';
        const h = deposited({ decimals: 18, amount: one }, '1');
        assertPaid(h, ok(call(h, 'cancel', 'buyer'), 'cancel'), 'buyer', one, 'cancel');
    });
    it('release pays out custody of exactly 1e21', function () {
        const big = '1000000000000000000000';
        const s = settled({ decimals: 0, amount: big }, 'release', 'buyer');
        assertPaid(s.h, s.r, 'seller', big, 'release');
    });
});

suite('held balance notation: vesting and escrowDelivery', function () {
    for (const d of DUST) {
        it('vesting cancel returns an unfunded deposit of ' + d.amount + ' on a ' + d.decimals + '-decimal tick', function () {
            const h = seeded(d.decimals, 'grantor', d.amount);
            ok(h.deploy({ code: code('vesting/vesting.js'), deployer: 'grantor', contractAddress: ADDR,
                params: ['grantor', 'bene', TICK, '1', '0', '10', 'false'] }), 'deploy');
            h.deposit('grantor', ADDR, TICK, d.amount);
            assertPaid(h, ok(call(h, 'cancel', 'grantor'), 'cancel'), 'grantor', d.amount, 'cancel');
        });
        it('escrowDelivery cancel returns an INIT deposit of ' + d.amount + ' on a ' + d.decimals + '-decimal tick', function () {
            const h = seeded(d.decimals, 'buyer', d.amount);
            ok(h.deploy({ code: code('escrowDelivery/escrowDelivery.js'), deployer: 'buyer', contractAddress: ADDR,
                params: ['buyer', 'seller', 'arbiter', TICK, '1', '3', '"status":"delivered"',
                    'https://carrier.example.com/track/1Z999'] }), 'deploy');
            h.deposit('buyer', ADDR, TICK, d.amount);
            assertPaid(h, ok(call(h, 'cancel', 'buyer'), 'cancel'), 'buyer', d.amount, 'cancel');
        });
    }
});

suite('held balance notation: auctions and cardDispenser', function () {
    const BID = 'BIDT';
    const auctions = [
        { rel: 'dutchAuction/dutchAuction.js', params: ['seller', TICK, '1', BID, '10', '1', '10'] },
        { rel: 'englishAuction/englishAuction.js', params: ['seller', TICK, '1', BID, '1', '10'] }
    ];
    for (const c of auctions) for (const d of DUST) {
        it(c.rel + ' cancel returns an INIT item deposit of ' + d.amount + ' on a ' + d.decimals + '-decimal tick', function () {
            const h = seeded(d.decimals, 'seller', d.amount);
            ok(h.deploy({ code: code(c.rel), deployer: 'seller', contractAddress: ADDR, params: c.params }), 'deploy');
            h.deposit('seller', ADDR, TICK, d.amount);
            assertPaid(h, ok(call(h, 'cancel', 'seller'), 'cancel'), 'seller', d.amount, 'cancel');
        });
    }
    for (const d of DUST) {
        it('cardDispenser withdraw sweeps ' + d.amount + ' of a ' + d.decimals + '-decimal tick', function () {
            const h = seeded(d.decimals, 'buyer', d.amount);
            h.seedBalance('owner', 'CARDA', '10');
            ok(h.deploy({ code: code('cardDispenser/cardDispenser.js'), deployer: 'owner', contractAddress: ADDR,
                params: [TICK, '1', '1', 'CARDA'] }), 'deploy');
            h.deposit('buyer', ADDR, TICK, d.amount);
            assertPaid(h, ok(call(h, 'withdraw', 'owner', [TICK]), 'withdraw'), 'owner', d.amount, 'withdraw');
        });
    }
});

suite('held balance notation: patterns/safe-transfer.js heldBalance', function () {
    it('returns fixed notation for sub-micro custody, so the documented payout pays it', function () {
        const lib = code('patterns/safe-transfer.js') + '\n' + code('patterns/validation.js');
        const probe = lib + '\nmodule.exports = { payout: function (xchain) {\n' +
            '  var amount = heldBalance(xchain, "' + TICK + '");\n' +
            '  xchain.require(!isAtLeastExact(xchain, "0", amount), "nothing to pay out");\n' +
            '  xchain.emit.send({ destination: "payee", tick: "' + TICK + '", quantity: amount });\n' +
            '  return amount;\n} };';
        const h = seeded(18, ADDR, '0.0000005');
        h.deploy({ code: probe, deployer: 'd', contractAddress: ADDR });
        const r = ok(call(h, 'payout', 'd'), 'payout');
        assert.strictEqual(r.result, '0.0000005');
        assertPaid(h, r, 'payee', '0.0000005', 'payout');
    });
});

// Line numbers of getBalance reads in `src` that are not the operand of an xchain.math
// call, so raw snapshot text could reach an emission, a state write or a string helper.
function rawBalanceReads(src) {
    const out = [];
    const re = /\bgetBalance\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
        if (line.indexOf('//') !== -1 || line.indexOf('`') !== -1) continue;
        // Walk back to the innermost unclosed '(' and require it to open an xchain.math call.
        let depth = 0, wrapped = false;
        for (let i = m.index - 1; i >= 0; i--) {
            const ch = src[i];
            if (ch === ')') depth++;
            else if (ch === '(') {
                if (depth === 0) { wrapped = /xchain\.math\.\w+\s*$/.test(src.slice(Math.max(0, i - 40), i)); break; }
                depth--;
            } else if (ch === ';' || ch === '{' || ch === '}') break;
        }
        if (!wrapped) out.push(src.slice(0, m.index).split('\n').length);
    }
    return out;
}

// Every <name>/<name>.js template plus every pattern library file.
function templateSources() {
    const rels = [];
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const rel = e.name + '/' + e.name + '.js';
        if (fs.existsSync(path.join(ROOT, rel))) rels.push(rel);
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'patterns'))) {
        if (/\.js$/.test(f) && !/\.test\.js$/.test(f)) rels.push('patterns/' + f);
    }
    return rels.sort();
}

describe('template getBalance reads are normalised through xchain.math', function () {
    it('the scan flags a raw read and passes a wrapped one', function () {
        assert.deepStrictEqual(rawBalanceReads("var held = xchain.getBalance(self, t) || '0';\n"), [1]);
        assert.deepStrictEqual(rawBalanceReads("var q = xchain.math.add(xchain.getBalance(self, t) || '0', '0');\n"), []);
        assert.deepStrictEqual(rawBalanceReads("var q = xchain.math.subtract(\n    xchain.getBalance(self, t) || '0', r);\n"), []);
        assert.deepStrictEqual(rawBalanceReads("var q = xchain.math.add(f(xchain.getBalance(self, t)), '0');\n"), [1]);
    });

    it('every template and pattern file wraps its getBalance reads', function () {
        const rels = templateSources();
        assert.ok(rels.length >= 15, 'template discovery found only ' + rels.length + ' files');
        let reads = 0;
        const bad = [];
        for (const rel of rels) {
            const src = code(rel);
            reads += (src.match(/\bgetBalance\s*\(/g) || []).length;
            for (const line of rawBalanceReads(src)) bad.push(rel + ':' + line);
        }
        assert.ok(reads >= 30, 'only ' + reads + ' getBalance reads found; the scan has lost its population');
        assert.deepStrictEqual(bad, [], 'raw getBalance reads: wrap each in xchain.math.add(<read> || \'0\', \'0\')');
    });
});
