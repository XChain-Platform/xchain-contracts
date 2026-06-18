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

const { lintSource } = require('../../xchain-vm/src/lint-core.js');

const DIR = __dirname;
const PATTERN_FILES = fs.readdirSync(DIR).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

describe('contract pattern library', function () {

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
