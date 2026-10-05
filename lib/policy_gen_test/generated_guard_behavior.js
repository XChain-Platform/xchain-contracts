// SPDX-License-Identifier: MIT

'use strict';

function registerAccessCases(deps) {
    const {
        assert, generatePolicy, loadContract, mockXchain, assertReverts,
        OWNER, NOTOWNER, MATRIX
    } = deps;

        it('pausable: guard allows until paused, blocks while paused; owner-gated', function () {
            const c = loadContract(generatePolicy(MATRIX.pauseOnly).source);
            const x = mockXchain({ source: OWNER });
            c.initialize(x);
            assert.strictEqual(x._state.get('paused'), 'false');
            assert.deepStrictEqual(c.guard(mockXchain({ state: { paused: 'false' } })), {});
            assertReverts(c.pause, mockXchain({ source: NOTOWNER }), 'not owner');
            c.pause(x);
            assert.strictEqual(x._state.get('paused'), 'true');
            assertReverts(c.guard, mockXchain({ state: { paused: 'true' } }), 'paused');
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
            assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Clean', '1AlsoClean'] })), {});
            assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Frozen', '1Clean'] }), 'frozen');
            assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Clean', '1Frozen'] }), 'frozen');
            const admin = mockXchain({ source: OWNER, state: st, inputs: ['1NewBad'] });
            c.freeze(admin);
            assert.strictEqual(admin._state.get('frozen:1NewBad'), 'true');
            assertReverts(c.guard, mockXchain({ state: Object.fromEntries(admin._state), inputs: ['SEND', '1NewBad', '1Clean'] }), 'frozen');
            c.unfreeze(mockXchain({ source: OWNER, state: Object.fromEntries(admin._state), inputs: ['1Frozen'] }));
            assertReverts(c.freeze, mockXchain({ source: NOTOWNER, inputs: ['1x'] }), 'not owner');
            assertReverts(c.freeze, mockXchain({ source: OWNER, inputs: [''] }), 'address argument required');
        });
}

function registerBasicAllowlistCases(deps) {
    const {
        assert, generatePolicy, loadContract, mockXchain, assertReverts,
        OWNER, MATRIX
    } = deps;

        it('allowlist: guard blocks a non-allowlisted sender; seeded + runtime allow/disallow', function () {
            const c = loadContract(generatePolicy(MATRIX.allowOnly).source);
            const init = mockXchain({ source: OWNER });
            c.initialize(init);
            assert.strictEqual(init._state.get('allow:1Good'), 'true');
            const st = Object.fromEntries(init._state);
            assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Good', '1Anyone'] })), {});
            assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Stranger', '1Anyone'] }), 'not allowlisted');
            const admin = mockXchain({ source: OWNER, state: st, inputs: ['1NewGood'] });
            c.allow(admin);
            assert.deepStrictEqual(c.guard(mockXchain({ state: Object.fromEntries(admin._state), inputs: ['SEND', '1NewGood', '1x'] })), {});
            c.disallow(mockXchain({ source: OWNER, state: Object.fromEntries(admin._state), inputs: ['1NewGood'] }));
        });

        it('allowlist: the default direction is sender-only, and emits no recipient check', function () {
            const gen = generatePolicy(MATRIX.allowOnly);
            assert.strictEqual(gen.features.allowlistDirection, 'from');
            const body = gen.source.slice(gen.source.indexOf('guard: function'));
            assert.ok(body.indexOf('requireAllowed(xchain, from)') !== -1, 'sender check missing');
            assert.ok(body.indexOf('requireAllowed(xchain, to)') === -1, 'default must not check the recipient');
            assert.ok(gen.source.indexOf('allowlistDirection: "from"') !== -1,
                'the resolved direction must reach the policy descriptor wallets read');
            assert.strictEqual(generatePolicy(Object.assign({}, MATRIX.allowOnly, { allowlistDirection: 'from' })).source, gen.source);
        });
}

function registerDirectedAllowlistCases(deps) {
    const {
        assert, generatePolicy, loadContract, mockXchain, assertReverts,
        OWNER, MATRIX
    } = deps;

        it('allowlist "both": a non-allowlisted RECIPIENT is blocked; an empty recipient is exempt', function () {
            const c = loadContract(generatePolicy(MATRIX.allowBoth).source);
            const init = mockXchain({ source: OWNER });
            c.initialize(init);
            const st = Object.fromEntries(init._state);
            assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Good', '1AlsoGood'] })), {});
            assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Good', '1Stranger'] }), 'not allowlisted');
            assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Stranger', '1Good'] }), 'not allowlisted');
            assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['DESTROY', '1Good', ''] })), {});
            assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['ORDER_CREATE', '1Good', ''] })), {});
            const admin = mockXchain({ source: OWNER, state: st, inputs: ['1Stranger'] });
            c.allow(admin);
            assert.deepStrictEqual(
                c.guard(mockXchain({ state: Object.fromEntries(admin._state), inputs: ['SEND', '1Good', '1Stranger'] })), {});
        });

        it('allowlist "to": the recipient is checked and any address may send', function () {
            const c = loadContract(generatePolicy(MATRIX.allowTo).source);
            const init = mockXchain({ source: OWNER });
            c.initialize(init);
            const st = Object.fromEntries(init._state);
            assert.deepStrictEqual(c.guard(mockXchain({ state: st, inputs: ['SEND', '1Stranger', '1Good'] })), {});
            assertReverts(c.guard, mockXchain({ state: st, inputs: ['SEND', '1Good', '1Stranger'] }), 'not allowlisted');
        });

        it('allowlist "both" + freeze: `var to` is declared exactly once in the guard body', function () {
            const src = generatePolicy(MATRIX.fullBoth).source;
            const body = src.slice(src.indexOf('guard: function'));
            assert.strictEqual(body.split('var to = toAddr(xchain);').length - 1, 1);
            assert.strictEqual(body.split('var from = fromAddr(xchain);').length - 1, 1);
        });
}

function registerRoyaltyCases(deps) {
    const {
        assert, generatePolicy, loadContract, mockXchain,
        CREATOR, MATRIX
    } = deps;

        it('royalty: guard returns payoutLegs on trade actions, {} otherwise', function () {
            const c = loadContract(generatePolicy(MATRIX.royaltyOnly).source);
            assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['ORDER_CREATE', '1m', '1t'] })), { payoutLegs: [{ to: CREATOR, bps: 500 }] });
            assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['SWAP_CREATE', '1m', '1t'] })), { payoutLegs: [{ to: CREATOR, bps: 500 }] });
            assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['SEND', '1m', '1t'] })), {});
        });

        it('royalty: a dispenser create is allowed with no legs, and the header and hints say so', function () {
            const gen = generatePolicy(MATRIX.royaltyOnly);
            const c = loadContract(gen.source);
            assert.deepStrictEqual(c.guard(mockXchain({ inputs: ['DISPENSER_CREATE', '1m', ''] })), {});
            const header = gen.source.slice(0, gen.source.indexOf('module.exports'));
            assert.ok(header.indexOf('// Royalty scope: the proceeds split is returned for ORDER_CREATE and') !== -1, 'header lacks the royalty scope note');
            assert.ok(header.indexOf('dispenser sales pay NO split') !== -1, 'header does not disclose the dispenser gap');
            assert.ok(gen.bindHints.indexOf('Royalty scope:') !== -1, 'bind hints lack the royalty scope note');
            assert.ok(gen.bindHints.indexOf('dispenser sales pay NO split') !== -1, 'bind hints do not disclose the dispenser gap');
        });

        it('royalty scope note is emitted only when a royalty is configured', function () {
            for (const key of ['pauseOnly', 'freezeOnly', 'allowOnly', 'allowBoth', 'allowTo']) {
                const gen = generatePolicy(MATRIX[key]);
                assert.strictEqual(gen.source.indexOf('Royalty scope'), -1, key + ' has no royalty but emits the note');
                assert.strictEqual(gen.bindHints.indexOf('Royalty scope'), -1, key + ' has no royalty but hints the note');
                assert.strictEqual(gen.source.indexOf('Cross-chain listings:'), -1, key + ' has no royalty but emits the cross-chain note');
            }
            for (const key of ['full', 'fullBoth', 'royaltyOnly']) {
                assert.ok(generatePolicy(MATRIX[key]).source.indexOf('// Royalty scope') !== -1, key + ' configures a royalty but omits the note');
            }
        });

        it('royalty: the header and hints disclose the cross-chain listing denial', function () {
            const gen = generatePolicy(MATRIX.royaltyOnly);
            const header = gen.source.slice(0, gen.source.indexOf('module.exports'));
            for (const text of [header, gen.bindHints]) {
                assert.ok(text.indexOf('Cross-chain listings:') !== -1, 'royalty scope lacks the cross-chain paragraph');
                assert.ok(text.indexOf('CROSS_CHAIN_ROYALTY') !== -1, 'cross-chain paragraph does not name the flag');
                assert.ok(text.indexOf('payable on the proceeds chain') !== -1, 'cross-chain paragraph omits the re-encode rule');
            }
            assert.ok(header.indexOf('// Cross-chain listings:') !== -1, 'header cross-chain line is not a comment line');
        });
}

function registerFullPolicyCase(deps) {
    const {
        assert, generatePolicy, loadContract, mockXchain, assertReverts,
        OWNER, CREATOR, MARKET, MATRIX
    } = deps;

        it('full policy: manifest fields + descriptor are present and correct', function () {
            const gen = generatePolicy(MATRIX.full);
            const c = loadContract(gen.source);
            assert.deepStrictEqual(c.permissions, ['SEND']);
            assert.strictEqual(c.maxTakeBps, 1000);
            assert.strictEqual(c.policy.generated, true);
            assert.deepStrictEqual(c.policy.gates, ['transfer', 'trade']);
            assert.deepStrictEqual(c.policy.features, ['pausable', 'freeze', 'allowlist', 'royalty']);
            const init = mockXchain({ source: OWNER });
            c.initialize(init);
            const st = Object.fromEntries(init._state);
            assert.deepStrictEqual(
                c.guard(mockXchain({ state: st, inputs: ['ORDER_CREATE', '1Good', '1Buyer'] })),
                { payoutLegs: [{ to: CREATOR, bps: 250 }, { to: MARKET, bps: 100 }] }
            );
            const paused = Object.assign({}, st, { paused: 'true' });
            assertReverts(c.guard, mockXchain({ state: paused, inputs: ['SEND', '1Good', '1Buyer'] }), 'paused');
        });
}

module.exports = function registerGeneratedGuardBehavior(deps) {
    describe('policy-gen: generated guard behaviour (mock xchain)', function () {
        registerAccessCases(deps);
        registerBasicAllowlistCases(deps);
        registerDirectedAllowlistCases(deps);
        registerRoyaltyCases(deps);
        registerFullPolicyCase(deps);
    });
};
