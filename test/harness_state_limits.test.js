// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// test/harness_state_limits.test.js: the in-process harness applies VM state and math rules
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The invariant suites run templates on test/helpers/harness.js, so a state write the
// VM refuses must fail there too. Each case runs the same write against the real
// StateManager when the sibling xchain-vm checkout is present.

'use strict';

const assert = require('assert');
const path = require('path');
const { available, Harness, makeMath, STATE_LIMITS, MAX_MATH_INPUT_LENGTH } = require('./helpers/harness');

const VM_SRC = path.join(__dirname, '..', '..', 'xchain-vm', 'src');
let StateManager = null, resolveLimits = null;
let buildMathAPI = null;
try {
    StateManager = require(path.join(VM_SRC, 'state.js'));
    if (StateManager.StateManager) StateManager = StateManager.StateManager;
    ({ resolveLimits } = require(path.join(VM_SRC, 'index', 'runtime', 'limits_defaults.js')));
    ({ buildMathAPI } = require(path.join(VM_SRC, 'math.js')));
} catch (e) { StateManager = null; }

const ADDR = 'C:BTC:1';

// A contract whose put(key, value) and drop(key) write state straight from params.
const PROBE = [
    'module.exports = {',
    '    put: function (x) { x.state.set(x.getInputParam(0), JSON.parse(x.getInputParam(1))); },',
    '    putNumber: function (x) { x.state.set(x.getInputParam(0), Number(x.getInputParam(1))); },',
    '    drop: function (x) { x.state.delete(x.getInputParam(0)); }',
    '};'
].join('\n');

function probe(limits) {
    const h = new Harness({ limits: limits });
    h.deploy({ code: PROBE, contractAddress: ADDR, deployer: 'd' });
    return h;
}

function call(h, method, params) {
    return h.execute({ contractAddress: ADDR, method: method, params: params, caller: 'd' });
}

// Return the real StateManager's error for one write, or null when it accepts it.
function vmVerdict(limits, seed, write) {
    if (!StateManager) return undefined;
    const sm = new StateManager(seed, Object.assign({}, STATE_LIMITS, limits),
        { rejectNulKeys: true, normalizeKeys: true });
    try { write(sm); return null; } catch (e) { return e.message; }
}

(available ? describe : describe.skip)('test harness: VM state rules', function () {
    it('uses the VM default state caps', function () {
        if (!resolveLimits) this.skip();
        const vm = resolveLimits();
        assert.strictEqual(STATE_LIMITS.maxStateKeys, vm.maxStateKeys);
        assert.strictEqual(STATE_LIMITS.maxStateValueSize, vm.maxStateValueSize);
        const src = require('fs').readFileSync(path.join(VM_SRC, 'state.js'), 'utf8');
        assert.ok(src.includes('maxStateKeySize || ' + STATE_LIMITS.maxStateKeySize),
            'xchain-vm state.js no longer falls back to a ' + STATE_LIMITS.maxStateKeySize + '-byte key cap');
    });

    it('refuses a new key at the key cap and reverts the call', function () {
        const h = probe({ maxStateKeys: 2 });
        assert.ok(call(h, 'put', ['a', '"1"']).success);
        assert.ok(call(h, 'put', ['b', '"1"']).success);
        const r = call(h, 'put', ['c', '"1"']);
        assert.strictEqual(r.success, false);
        assert.ok(r.error.includes('max state keys'), r.error);
        assert.strictEqual(h.state(ADDR, 'c'), null);
        assert.strictEqual(vmVerdict({ maxStateKeys: 2 }, { a: '1', b: '1' }, (sm) => sm.set('c', '1')),
            StateManager ? r.error : undefined);
        // Overwriting a live key needs no slot, and a delete frees one.
        assert.ok(call(h, 'put', ['a', '"2"']).success);
        assert.ok(call(h, 'drop', ['b']).success);
        assert.ok(call(h, 'put', ['c', '"1"']).success);
    });

    it('refuses the keys and values the VM refuses', function () {
        const h = probe({ maxStateValueSize: 16, maxStateKeySize: 4 });
        const cases = [
            ['put', ['k', 'null'], (sm) => sm.set('k', null)],
            ['putNumber', ['k', 'NaN'], (sm) => sm.set('k', NaN)],
            ['putNumber', ['k', 'Infinity'], (sm) => sm.set('k', Infinity)],
            ['put', ['k', '"' + 'x'.repeat(20) + '"'], (sm) => sm.set('k', 'x'.repeat(20))],
            ['put', ['kkkkk', '"1"'], (sm) => sm.set('kkkkk', '1')],
            ['put', ['k\u0000', '"1"'], (sm) => sm.set('k\u0000', '1')]
        ];
        for (const [method, params, write] of cases) {
            const r = call(h, method, params);
            assert.strictEqual(r.success, false, method + ' ' + JSON.stringify(params) + ' was accepted');
            const vm = vmVerdict({ maxStateValueSize: 16, maxStateKeySize: 4 }, {}, write);
            if (vm !== undefined) assert.strictEqual(r.error, vm);
        }
        assert.ok(call(h, 'put', ['k', '"ok"']).success);
    });
});

(available ? describe : describe.skip)('test harness: VM math rules', function () {
    function outcome(fn) {
        try { return { value: fn() }; }
        catch (e) { return { error: String(e && e.message || e) }; }
    }

    function assertParity(model, real, method, args) {
        const left = outcome(() => model[method](...args));
        const right = outcome(() => real[method](...args));
        assert.strictEqual(Boolean(left.error), Boolean(right.error), method + '(' + args.join(',') + ') throw mismatch');
        if (!left.error) assert.strictEqual(left.value, right.value, method + '(' + args.join(',') + ') result mismatch');
    }

    it('matches the VM surface and edge-case results it models', function () {
        if (!buildMathAPI) this.skip();
        const model = makeMath();
        const real = buildMathAPI(null);
        for (const key of Object.keys(model)) assert.strictEqual(typeof real[key], 'function', key + ' is not a VM math method');
        const cases = [
            ['min', ['1.0000000000005', '1']], ['min', ['1', '1.0000000000005']],
            ['max', ['1.0000000000005', '1']], ['max', ['1', '1.0000000000005']],
            ['min', ['2', '1']], ['max', ['2', '1']], ['sqrt', ['4']],
            ['divide', ['1', '0']], ['sqrt', ['-1']]
        ];
        for (const [method, args] of cases) assertParity(model, real, method, args);
    });

    it('accepts 256-character operands and rejects 257-character operands', function () {
        if (!buildMathAPI) this.skip();
        const model = makeMath();
        const real = buildMathAPI(null);
        const accepted = '1'.repeat(MAX_MATH_INPUT_LENGTH);
        const refused = '1'.repeat(MAX_MATH_INPUT_LENGTH + 1);
        for (const method of ['add', 'compare', 'min']) {
            assertParity(model, real, method, [accepted, '1']);
            assertParity(model, real, method, [refused, '1']);
        }
    });
});
