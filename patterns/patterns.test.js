// SPDX-License-Identifier: MIT
//
// Pattern-library lint gate. Every snippet here is meant to be pasted into a
// real contract, so each one (and a contract composed from several) must pass
// `xchain-lint` clean (zero errors, zero warnings). Uses lint-core directly
// (pure acorn, no isolated-vm), so it runs on any Node.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js patterns/patterns.test.js
//   (or from xchain-vm:  npx mocha ../xchain-contracts/patterns/patterns.test.js)

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

let lintSource;
try { ({ lintSource } = require('../../xchain-vm/src/lint-core.js')); }
catch (e) { console.log('Skipping pattern lint tests: xchain-vm linter not available (need adjacent xchain-vm install)'); }

const DIR = __dirname;
const PATTERN_FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

(lintSource ? describe : describe.skip)('contract pattern library', function () {

    describe('every pattern file is lint-clean', function () {
        for (const f of PATTERN_FILES) {
            it(f + ' → 0 errors, 0 warnings', function () {
                const r = lintSource(fs.readFileSync(path.join(DIR, f), 'utf8'));
                assert.strictEqual(r.errors.length, 0, f + ' errors: ' + JSON.stringify(r.errors.map(e => e.rule)));
                assert.strictEqual(r.warnings.length, 0, f + ' warnings: ' + JSON.stringify(r.warnings.map(w => w.rule)));
            });
        }
    });

    describe('a contract composed from the patterns is lint-clean', function () {
        // Pastes access-control + pausable + state-machine + validation + safe-transfer
        // helpers and uses them (the documented authoring model). Critically, the
        // methods validate via require* helpers (not a direct xchain.require), which
        // must NOT trip the missing-input-validation warning.
        const COMPOSED = [
            "function onlyOwner(xchain) { xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'not owner'); }",
            "function whenNotPaused(xchain) { xchain.require(xchain.state.get('paused') !== 'true', 'paused'); }",
            "function requireStatus(xchain, e) { xchain.require(xchain.state.get('status') === e, 'bad state'); }",
            "function setStatus(xchain, n) { xchain.state.set('status', n); }",
            "function requireAddress(xchain, v, name) { xchain.require(typeof v === 'string' && v.length > 0, name); }",
            "function requirePositive(xchain, a, name) { xchain.require(a && xchain.math.gt(a, '0'), name); }",
            "function heldBalance(xchain, tick) { return xchain.getBalance(xchain.getContractAddress(), tick) || '0'; }",
            "module.exports = {",
            "  initialize: function (xchain) {",
            "    var owner = xchain.getInputParam(0);",
            "    var amount = xchain.getInputParam(1);",
            "    requireAddress(xchain, owner, 'owner required');",  // validation via helper, not direct require
            "    requirePositive(xchain, amount, 'amount must be positive');",
            "    xchain.state.set('owner', owner);",
            "    xchain.state.set('status', 'OPEN');",
            "  },",
            "  payout: function (xchain) {",
            "    onlyOwner(xchain);",
            "    whenNotPaused(xchain);",
            "    requireStatus(xchain, 'OPEN');",
            "    var tick = xchain.state.get('tick');",
            "    var amount = heldBalance(xchain, tick);",
            "    setStatus(xchain, 'PAID');",
            "    xchain.emit.send({ destination: xchain.state.get('owner'), tick: tick, quantity: amount });",
            "  }",
            "};"
        ].join('\n');

        it('lints with zero errors and zero warnings', function () {
            const r = lintSource(COMPOSED);
            assert.strictEqual(r.errors.length, 0, 'errors: ' + JSON.stringify(r.errors.map(e => e.rule)));
            assert.strictEqual(r.warnings.length, 0, 'warnings: ' + JSON.stringify(r.warnings.map(w => w.rule)));
        });

        it('validation-via-helper is NOT flagged as missing-input-validation', function () {
            const r = lintSource(COMPOSED);
            assert.ok(!r.warnings.some(w => w.rule === 'missing-input-validation'),
                'initialize() validates via requireAddress/requirePositive helpers');
        });
    });

});

// --- Library-versus-template parity -----------------------------------------
//
// XChain contracts are one self-contained blob with no imports, so a template
// that uses a pattern helper PASTES it rather than requiring it. That is the
// authoring model, but it means a fix to the library reaches the templates only
// if someone re-pastes it, and the failure is silent: a template keeps running
// the stale copy and its own tests keep passing.
//
// So pin it. Every template copy of a library helper must be byte-identical to
// the library's. Header comments are deliberately NOT compared: each template
// documents the hazard in its own terms and points back here. Only the executable
// body is consensus-relevant, and it is the part that must never drift.
//
// This block does not need the linter, so it runs on any Node.
describe('pattern helpers pasted into templates match the library source', function () {

    const ROOT = path.join(DIR, '..');

    // Source text of a top-level `function NAME(...) { ... }`, signature through
    // the closing brace in column 0. Plain string scanning, no parser: the helpers
    // are hand-written top-level declarations and every nested brace inside them
    // is indented, which is exactly the shape the linter already enforces.
    function helperSource(file, name) {
        const src = fs.readFileSync(file, 'utf8');
        const start = src.indexOf('\nfunction ' + name + '(');
        assert.notStrictEqual(start, -1, name + ' not found in ' + path.relative(ROOT, file));
        const end = src.indexOf('\n}\n', start);
        assert.notStrictEqual(end, -1, name + ' has no column-0 closing brace in ' + path.relative(ROOT, file));
        return src.slice(start + 1, end + 3);
    }

    // helper -> templates that paste it. Add a row when a template adopts one.
    const PASTED = {
        requirePlainDecimal: [
            'priceBet/priceBet.js',
            'priceBetTimed/priceBetTimed.js',
            'stableVault/stableVault.js',
            'treasury/treasury.js'
        ],
        requireIntInRange: [
            'crowdsale/crowdsale.js',
            'priceBet/priceBet.js',
            'priceBetTimed/priceBetTimed.js',
            'stableVault/stableVault.js',
            'treasury/treasury.js'
        ]
    };

    for (const name of Object.keys(PASTED)) {
        describe(name, function () {
            const canonical = helperSource(path.join(DIR, 'validation.js'), name);

            it('is exported by the pattern library', function () {
                assert.ok(canonical.length > 0);
            });

            for (const rel of PASTED[name]) {
                it(rel + ' pastes the library body verbatim', function () {
                    assert.strictEqual(helperSource(path.join(ROOT, rel), name), canonical,
                        rel + ' has drifted from patterns/validation.js:' + name +
                        ' - re-paste the library body (comments above it may differ)');
                });
            }
        });
    }

    // The bridge deliberately carries a PREDICATE variant (it filters rows rather
    // than reverting), so it cannot be body-identical. What it must not do is
    // disagree about which strings are plain decimals.
    it('counterpartyBridge isPlainDecimal accepts exactly what requirePlainDecimal accepts', function () {
        const lib = helperSource(path.join(DIR, 'validation.js'), 'requirePlainDecimal');
        const bridge = helperSource(path.join(ROOT, 'counterpartyBridge/counterpartyBridge.js'), 'isPlainDecimal');
        const requirePlainDecimal = new Function('return (' + lib + ')')();
        const isPlainDecimal = new Function('return (' + bridge + ')')();
        const xchain = { require: (ok, msg) => { if (!ok) throw new Error(msg); } };
        const CASES = [
            '1', '0', '10.5', '0.00000001', '123456789.123456789',
            '', '.5', '5.', '1.5e-8', '0x10', '1_000', '+1', '-1', 'Infinity',
            'abc', '1.2.3', ' 1', '1 ', 'NaN', '1e2'
        ];
        for (const c of CASES) {
            let requireAccepts = true;
            try { requirePlainDecimal(xchain, c, 'v'); } catch (e) { requireAccepts = false; }
            assert.strictEqual(isPlainDecimal(c), requireAccepts,
                'disagreement on ' + JSON.stringify(c) +
                ': isPlainDecimal=' + isPlainDecimal(c) + ' requirePlainDecimal accepts=' + requireAccepts);
        }
    });

});
