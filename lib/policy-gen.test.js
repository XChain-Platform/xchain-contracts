// SPDX-License-Identifier: MIT
//
// Tests for the Tier 0 no-code token-policy generator (lib/policy-gen.js).
//
// Two layers, both deliberately VM-free so they run on any Node:
//   1. Config validation + lint: every generated guard must pass lint-core's
//      acorn rules with ZERO errors and ZERO warnings. lint-core is a SUBSET of
//      the deploy gate, not the deploy gate: per its own header it carries every
//      deploy-time check EXCEPT the V8 syntax compile, which needs isolated-vm
//      and lives in xchain-vm/src/syntax.js. The lint block skips gracefully if
//      the adjacent xchain-vm checkout is absent.
//   2. Behaviour: load the generated source as a CommonJS module against a mock
//      `xchain` and exercise the guard / admin methods directly. This proves the
//      enforcement logic runs, but under Node's parser and a hand-written mock,
//      not the isolate and not the real sandbox.
//
// The REAL deploy gate (vm.validateSyntax through E2EHarness.deploy, plus
// execution on the isolate) is lib/policy-gen.e2e.test.js, which needs Node 22
// and a built isolated-vm. Neither file alone is deploy parity; together they
// are, and both drive the same configs from test/policy-matrix.js.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js lib/policy-gen.test.js
//   (or, from the repo test script, as part of `npm test`)

'use strict';

const assert = require('assert');
const { generatePolicy, validateConfig, BINDABLE_CLASSES, MAX_BPS, PROTOCOL_MAX_TAKE_BPS } = require('./policy-gen.js');
const POLICY_EXAMPLE = require('./policy.example.json');
const { OWNER, NOTOWNER, CREATOR, MARKET, MATRIX } = require('../test/policy-matrix.js');
const registerConfigValidation = require('./policy_gen_test/configuration_validation.js');
const registerDeadHelperDetection = require('./policy_gen_test/dead_helper_detection.js');
const registerGeneratedGuardBehavior = require('./policy_gen_test/generated_guard_behavior.js');
const registerBindHints = require('./policy_gen_test/bind_hints.js');
const registerMetadataIdentity = require('./policy_gen_test/metadata_identity.js');

// Load xchain-vm's lint core at src/lint-core.js, falling back to src/lint_core.js,
// the name an older adjacent checkout may still carry. Pinning one spelling would
// leave lintSource undefined there and skip every lint assertion while still green.
const LINT_CORE_SPELLINGS = ['../../xchain-vm/src/lint-core.js',
                             '../../xchain-vm/src/lint_core.js'];
let lintSource;
for (const spec of LINT_CORE_SPELLINGS) {
    try { ({ lintSource } = require(spec)); break; }
    catch (e) {
        // Only an unresolvable module falls through: to the next spelling, or to
        // the lint block's skip below when there is no adjacent xchain-vm (or no
        // install in it) at all. A lint-core that is present and throws while
        // loading is a real error and must not be swallowed here.
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
}

// Load a generated contract source as a CJS module (no isolated-vm).
function loadContract(src) {
    const mod = { exports: {} };
    // eslint-disable-next-line no-new-func
    const fn = new Function('module', 'exports', src);
    fn(mod, mod.exports);
    return mod.exports;
}

// Minimal deterministic mock of the in-VM `xchain` object.
function mockXchain(opts) {
    opts = opts || {};
    const state = new Map(Object.entries(opts.state || {}));
    const inputs = opts.inputs || [];
    return {
        state: {
            get: (k) => (state.has(k) ? state.get(k) : null),
            set: (k, v) => { state.set(k, String(v)); }
        },
        getInputParam: (i) => inputs[i],
        getSourceAddress: () => opts.source,
        require: (cond, msg) => { if (!cond) { const e = new Error(msg); e.reverted = true; throw e; } },
        revert: (msg) => { const e = new Error(msg); e.reverted = true; throw e; },
        _state: state
    };
}

// Assert that fn(x) reverts (via require/revert), optionally matching a substring.
function assertReverts(fn, x, sub) {
    let threw = null;
    try { fn(x); } catch (e) { threw = e; }
    assert.ok(threw && threw.reverted, 'expected a revert, got ' + (threw ? threw.message : 'no throw'));
    if (sub) assert.ok(threw.message.indexOf(sub) !== -1, 'revert "' + threw.message + '" should contain "' + sub + '"');
}

registerConfigValidation({
    assert, validateConfig, BINDABLE_CLASSES, MAX_BPS, PROTOCOL_MAX_TAKE_BPS,
    OWNER, CREATOR, MARKET
});

(lintSource ? describe : describe.skip)('policy-gen: every generated guard is lint-clean', function () {
    for (const key of Object.keys(MATRIX)) {
        it(key + ' → 0 errors, 0 warnings', function () {
            const { source } = generatePolicy(MATRIX[key]);
            const r = lintSource(source);
            assert.strictEqual(r.errors.length, 0, key + ' errors: ' + JSON.stringify(r.errors.map(e => e.rule)));
            assert.strictEqual(r.warnings.length, 0, key + ' warnings: ' + JSON.stringify(r.warnings.map(w => w.rule)));
        });
    }
});

registerDeadHelperDetection({ assert, generatePolicy, MATRIX });
registerGeneratedGuardBehavior({
    assert, generatePolicy, loadContract, mockXchain, assertReverts,
    OWNER, NOTOWNER, CREATOR, MARKET, MATRIX
});
registerBindHints({ assert, generatePolicy, MATRIX });
registerMetadataIdentity({
    assert, generatePolicy, loadContract, mockXchain,
    POLICY_EXAMPLE, OWNER, MATRIX
});
