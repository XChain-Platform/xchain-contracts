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
const { generatePolicy, validateConfig, BINDABLE_CLASSES } = require('./policy-gen.js');
const { OWNER, NOTOWNER, MATRIX } = require('../test/policy-matrix.js');

let lintSource;
try { ({ lintSource } = require('../../xchain-vm/src/lint-core.js')); }
catch (e) { /* lint block skips below */ }

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

describe('policy-gen: config validation', function () {

    it('rejects a non-object config', function () {
        assert.throws(() => validateConfig(null), /must be a JSON object/);
        assert.throws(() => validateConfig([]), /must be a JSON object/);
    });

    it('requires a non-empty gates array of known classes', function () {
        assert.throws(() => validateConfig({ pausable: true, owner: OWNER }), /gates must be a non-empty array/);
        assert.throws(() => validateConfig({ gates: [], pausable: true, owner: OWNER }), /gates must be a non-empty array/);
        assert.throws(() => validateConfig({ gates: ['bogus'], pausable: true, owner: OWNER }), /is not one of/);
    });

    it('accepts every bindable class including "all"', function () {
        for (const g of BINDABLE_CLASSES) {
            // pausable gives it a rule + owner
            const cfg = validateConfig({ gates: [g], pausable: true, owner: OWNER });
            assert.deepStrictEqual(cfg.gates, [g]);
        }
    });

    // Drift guard: BINDABLE_CLASSES must equal the indexer's canonical
    // CONTROLLER_BINDABLE_CLASSES (xchain-indexer/src/config.js). If the
    // indexer adds a routable class, this pin fails until the generator's
    // ACTION_CLASSES is updated to match, so the no-code path can never
    // silently reject a class the chain accepts (the 'ownership' drift).
    it('pins BINDABLE_CLASSES to the indexer canonical set', function () {
        assert.deepStrictEqual(
            BINDABLE_CLASSES,
            ['transfer', 'trade', 'burn', 'mint', 'stake', 'ownership', 'all']
        );
    });

    it('requires at least one rule', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'] }), /policy has no rules/);
    });

    it('requires an owner when a stateful feature is present', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'], pausable: true }), /owner is required/);
        assert.throws(() => validateConfig({ gates: ['transfer'], freeze: ['1x'] }), /owner is required/);
        assert.throws(() => validateConfig({ gates: ['transfer'], allowlist: ['1x'] }), /owner is required/);
    });

    it('does NOT require an owner for a royalty-only policy', function () {
        const cfg = validateConfig({ gates: ['trade'], royalty: [{ to: '1c', bps: 100 }] });
        assert.strictEqual(cfg.owner, null);
    });

    it('rejects an empty allowlist (would block everyone)', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, allowlist: [] }), /NON-empty/);
    });

    it('accepts an empty freeze seed (owner freezes at runtime)', function () {
        const cfg = validateConfig({ gates: ['transfer'], owner: OWNER, freeze: [] });
        assert.deepStrictEqual(cfg.freeze, []);
    });

    it('rejects royalty without a trade/all gate', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'], royalty: [{ to: '1c', bps: 100 }] }), /requires the "trade"/);
    });

    it('accepts royalty when the "all" gate is present', function () {
        const cfg = validateConfig({ gates: ['all'], royalty: [{ to: '1c', bps: 100 }] });
        assert.strictEqual(cfg.royalty.length, 1);
    });

    it('rejects royalty legs that exceed 100%', function () {
        assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: '1c', bps: 6000 }, { to: '1d', bps: 5000 }] }), /exceeds 100%/);
    });

    it('rejects royalty legs that exceed the declared maxTakeBps', function () {
        assert.throws(() => validateConfig({ gates: ['trade'], maxTakeBps: 200, royalty: [{ to: '1c', bps: 300 }] }), /exceeds the declared maxTakeBps/);
    });

    it('rejects non-integer / out-of-range bps', function () {
        assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: '1c', bps: 1.5 }] }), /bps must be an integer/);
        assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: '1c', bps: 0 }] }), /bps must be an integer/);
    });

    it('rejects an injection-shaped address', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: "1x'; hack()//" }), /owner must be a valid address/);
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, freeze: ["1a\nb"] }), /freeze address/);
    });

    it('rejects a non-integer maxTakeBps', function () {
        assert.throws(() => validateConfig({ gates: ['trade'], maxTakeBps: 99999, royalty: [{ to: '1c', bps: 1 }] }), /maxTakeBps must be an integer/);
    });

    it('rejects a malformed permission name', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, pausable: true, permissions: ['send'] }), /permission .* is invalid/);
    });

    it('defaults allowlistDirection to "from", and to null with no allowlist', function () {
        assert.strictEqual(validateConfig({ gates: ['transfer'], owner: OWNER, allowlist: ['1x'] }).allowlistDirection, 'from');
        assert.strictEqual(validateConfig({ gates: ['transfer'], owner: OWNER, pausable: true }).allowlistDirection, null);
    });

    it('accepts every allowlistDirection value and rejects anything else', function () {
        for (const d of ['from', 'to', 'both']) {
            assert.strictEqual(
                validateConfig({ gates: ['transfer'], owner: OWNER, allowlist: ['1x'], allowlistDirection: d }).allowlistDirection, d);
        }
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, allowlist: ['1x'], allowlistDirection: 'either' }),
            /allowlistDirection must be one of/);
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, allowlist: ['1x'], allowlistDirection: true }),
            /allowlistDirection must be one of/);
    });

    it('rejects allowlistDirection without an allowlist', function () {
        assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, pausable: true, allowlistDirection: 'both' }),
            /allowlistDirection requires an allowlist/);
    });
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

describe('policy-gen: generated guard behaviour (mock xchain)', function () {

    it('pausable: guard allows until paused, blocks while paused; owner-gated', function () {
        const c = loadContract(generatePolicy(MATRIX.pauseOnly).source);
        const x = mockXchain({ source: OWNER });
        c.initialize(x);
        assert.strictEqual(x._state.get('paused'), 'false');
        // not paused → allow
        assert.deepStrictEqual(c.guard(mockXchain({ state: { paused: 'false' } })), {});
        // non-owner cannot pause
        assertReverts(c.pause, mockXchain({ source: NOTOWNER }), 'not owner');
        // owner pauses → guard blocks
        c.pause(x);
        assert.strictEqual(x._state.get('paused'), 'true');
        assertReverts(c.guard, mockXchain({ state: { paused: 'true' } }), 'paused');
        // owner unpauses → allow again
        c.unpause(x);
        assert.strictEqual(x._state.get('paused'), 'false');
    });

    it('freeze: guard blocks a frozen from OR to; seeded + runtime freeze/unfreeze', function () {
        const gen = generatePolicy(MATRIX.freezeOnly);
        const c = loadContract(gen.source);
        const init = mockXchain({ source: OWNER });
        c.initialize(init);
        assert.strictEqual(init._state.get('frozen:1Frozen'), 'true');
        const st = Object.fromEntries(init._state);
        // clean from + clean to → allow
        assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Clean', '1AlsoClean'] })), {});
        // frozen sender → block
        assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Frozen', '1Clean'] }), 'frozen');
        // frozen recipient → block
        assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Clean', '1Frozen'] }), 'frozen');
        // owner freezes a new account at runtime
        const admin = mockXchain({ source: OWNER, state: st, inputs: ['1NewBad'] });
        c.freeze(admin);
        assert.strictEqual(admin._state.get('frozen:1NewBad'), 'true');
        assertReverts(c.guard, mockXchain({ state: Object.fromEntries(admin._state), inputs: ['SEND', '1NewBad', '1Clean'] }), 'frozen');
        // owner unfreezes
        c.unfreeze(mockXchain({ source: OWNER, state: Object.fromEntries(admin._state), inputs: ['1Frozen'] }));
        // non-owner cannot freeze; empty address arg rejected
        assertReverts(c.freeze, mockXchain({ source: NOTOWNER, inputs: ['1x'] }), 'not owner');
        assertReverts(c.freeze, mockXchain({ source: OWNER, inputs: [''] }), 'address argument required');
    });

    it('allowlist: guard blocks a non-allowlisted sender; seeded + runtime allow/disallow', function () {
        const c = loadContract(generatePolicy(MATRIX.allowOnly).source);
        const init = mockXchain({ source: OWNER });
        c.initialize(init);
        assert.strictEqual(init._state.get('allow:1Good'), 'true');
        const st = Object.fromEntries(init._state);
        // allowlisted sender → allow
        assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Good', '1Anyone'] })), {});
        // non-allowlisted sender → block
        assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Stranger', '1Anyone'] }), 'not allowlisted');
        // owner adds a sender
        const admin = mockXchain({ source: OWNER, state: st, inputs: ['1NewGood'] });
        c.allow(admin);
        assert.deepStrictEqual(c.guard(mockXchain({ state: Object.fromEntries(admin._state), inputs: ['SEND', '1NewGood', '1x'] })), {});
        // owner removes a sender → blocked again
        c.disallow(mockXchain({ source: OWNER, state: Object.fromEntries(admin._state), inputs: ['1NewGood'] }));
    });

    // The default is the COMPATIBLE direction, not the safe one, so it is pinned as a
    // deliberate choice rather than left to be inferred from the two tests above: the
    // emitted body must carry no recipient check at all, and '1Anyone' above must stay
    // allowed. A future flip of the default has to come here and say so.
    it('allowlist: the default direction is sender-only, and emits no recipient check', function () {
        const gen = generatePolicy(MATRIX.allowOnly);
        assert.strictEqual(gen.features.allowlistDirection, 'from');
        const body = gen.source.slice(gen.source.indexOf('guard: function'));
        assert.ok(body.indexOf('requireAllowed(xchain, from)') !== -1, 'sender check missing');
        assert.ok(body.indexOf('requireAllowed(xchain, to)') === -1, 'default must not check the recipient');
        assert.ok(gen.source.indexOf('allowlistDirection: "from"') !== -1,
            'the resolved direction must reach the policy descriptor wallets read');
        // Explicit 'from' is the default's own spelling: same source, byte for byte.
        assert.strictEqual(generatePolicy(Object.assign({}, MATRIX.allowOnly, { allowlistDirection: 'from' })).source, gen.source);
    });

    it('allowlist "both": a non-allowlisted RECIPIENT is blocked; an empty recipient is exempt', function () {
        const c = loadContract(generatePolicy(MATRIX.allowBoth).source);
        const init = mockXchain({ source: OWNER });
        c.initialize(init);
        const st = Object.fromEntries(init._state);
        // both ends allowlisted → allow
        assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Good', '1AlsoGood'] })), {});
        // allowlisted sender, stranger recipient → block (this is the whole point)
        assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Good', '1Stranger'] }), 'not allowlisted');
        // the sender check still runs
        assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Stranger', '1Good'] }), 'not allowlisted');
        // Empty recipient: the indexer passes '' for burns and every escrow-creating
        // action (DESTROY / ORDER_CREATE / SWAP_CREATE / DISPENSER_CREATE / AIRDROP /
        // DIVIDEND). An unconditional recipient check would deny all of them.
        assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['DESTROY', '1Good', ''] })), {});
        assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['ORDER_CREATE', '1Good', ''] })), {});
        // owner allows the stranger at runtime → the same SEND now clears
        const admin = mockXchain({ source: OWNER, state: st, inputs: ['1Stranger'] });
        c.allow(admin);
        assert.deepStrictEqual(
            c.guard(mockXchain({ state: Object.fromEntries(admin._state), inputs: ['SEND', '1Good', '1Stranger'] })), {});
    });

    it('allowlist "to": the recipient is checked and any address may send', function () {
        const c = loadContract(generatePolicy(Object.assign({}, MATRIX.allowOnly, { allowlistDirection: 'to' })).source);
        const init = mockXchain({ source: OWNER });
        c.initialize(init);
        const st = Object.fromEntries(init._state);
        assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Stranger', '1Good'] })), {});
        assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Good', '1Stranger'] }), 'not allowlisted');
    });

    it('allowlist "both" + freeze: `var to` is declared exactly once in the guard body', function () {
        // The freeze branch declares `var to` too. A second declaration would be a
        // redeclaration in the emitted source, which the deploy linter and the isolate
        // are entitled to reject, and no behavioural assertion above would notice.
        const src = generatePolicy(Object.assign({}, MATRIX.full, { allowlistDirection: 'both' })).source;
        const body = src.slice(src.indexOf('guard: function'));
        assert.strictEqual(body.split('var to = toAddr(xchain);').length - 1, 1);
        assert.strictEqual(body.split('var from = fromAddr(xchain);').length - 1, 1);
    });

    it('royalty: guard returns payoutLegs on trade actions, {} otherwise', function () {
        const c = loadContract(generatePolicy(MATRIX.royaltyOnly).source);
        assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['ORDER_CREATE', '1m', '1t'] })), { payoutLegs: [{ to: '1Creator', bps: 500 }] });
        assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['SWAP_CREATE', '1m', '1t'] })), { payoutLegs: [{ to: '1Creator', bps: 500 }] });
        assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['SEND', '1m', '1t'] })), {});
    });

    it('full policy: manifest fields + descriptor are present and correct', function () {
        const gen = generatePolicy(MATRIX.full);
        const c = loadContract(gen.source);
        assert.deepStrictEqual(c.permissions, ['SEND']);
        assert.strictEqual(c.maxTakeBps, 1000);
        assert.strictEqual(c.policy.generated, true);
        assert.deepStrictEqual(c.policy.gates, ['transfer', 'trade']);
        assert.deepStrictEqual(c.policy.features, ['pausable', 'freeze', 'allowlist', 'royalty']);
        // guard enforces the whole stack: allowed + unfrozen + not-paused sender, on a trade → legs
        const init = mockXchain({ source: OWNER });
        c.initialize(init);
        const st = Object.fromEntries(init._state);
        assert.deepStrictEqual(
            c.guard(mockXchain({ state: st, inputs: ['ORDER_CREATE', '1Good', '1Buyer'] })),
            { payoutLegs: [{ to: '1Creator', bps: 250 }, { to: '1Market', bps: 100 }] }
        );
        // a paused, allowlisted, unfrozen sender is still blocked by the pause gate
        const paused = Object.assign({}, st, { paused: 'true' });
        assertReverts(c.guard, mockXchain({ state: paused, inputs: ['SEND', '1Good', '1Buyer'] }), 'paused');
    });
});

describe('policy-gen: bind hints', function () {
    it('emits an ISSUE v6 line per gated class', function () {
        const gen = generatePolicy(MATRIX.full);
        for (const g of ['transfer', 'trade']) {
            assert.ok(gen.bindHints.indexOf('ACTION_CLASS=' + g) !== -1, 'missing bind hint for ' + g);
        }
        assert.ok(gen.bindHints.indexOf('VERSION=6') !== -1);
    });
});
