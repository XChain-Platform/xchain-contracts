// SPDX-License-Identifier: MIT

'use strict';

module.exports = function registerConfigurationValidation(deps) {
    const {
        assert, validateConfig, BINDABLE_CLASSES, MAX_BPS, PROTOCOL_MAX_TAKE_BPS,
        OWNER, CREATOR, MARKET
    } = deps;

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
                const cfg = validateConfig({ gates: [g], pausable: true, owner: OWNER });
                assert.deepStrictEqual(cfg.gates, [g]);
            }
        });

        it('pins BINDABLE_CLASSES against an unreviewed edit to the generator list', function () {
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
            const cfg = validateConfig({ gates: ['trade'], royalty: [{ to: CREATOR, bps: 100 }] });
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
            assert.throws(() => validateConfig({ gates: ['transfer'], royalty: [{ to: CREATOR, bps: 100 }] }), /requires the "trade"/);
        });

        it('accepts royalty when the "all" gate is present', function () {
            const cfg = validateConfig({ gates: ['all'], royalty: [{ to: CREATOR, bps: 100 }] });
            assert.strictEqual(cfg.royalty.length, 1);
        });

        it('rejects royalty legs that exceed 100%', function () {
            assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: CREATOR, bps: 6000 }, { to: MARKET, bps: 5000 }] }), /exceeds 100%/);
        });

        it('exports a protocol take cap within the 100% bound', function () {
            assert.ok(Number.isInteger(PROTOCOL_MAX_TAKE_BPS), 'PROTOCOL_MAX_TAKE_BPS is not an integer');
            assert.ok(PROTOCOL_MAX_TAKE_BPS >= 0 && PROTOCOL_MAX_TAKE_BPS <= MAX_BPS, 'PROTOCOL_MAX_TAKE_BPS is outside [0, MAX_BPS]');
        });

        it('accepts royalty legs that sum exactly to the protocol cap', function () {
            const half = Math.floor(PROTOCOL_MAX_TAKE_BPS / 2);
            const cfg = validateConfig({ gates: ['trade'], royalty: [{ to: CREATOR, bps: half }, { to: MARKET, bps: PROTOCOL_MAX_TAKE_BPS - half }] });
            assert.strictEqual(cfg.royalty.reduce((s, l) => s + l.bps, 0), PROTOCOL_MAX_TAKE_BPS);
        });

        it('rejects royalty legs one bps over the protocol cap', function () {
            const half = Math.floor(PROTOCOL_MAX_TAKE_BPS / 2);
            assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: CREATOR, bps: half }, { to: MARKET, bps: PROTOCOL_MAX_TAKE_BPS - half + 1 }] }), /exceeds/);
        });

        it('rejects royalty legs that exceed the declared maxTakeBps', function () {
            assert.throws(() => validateConfig({ gates: ['trade'], maxTakeBps: 200, royalty: [{ to: CREATOR, bps: 300 }] }), /exceeds the declared maxTakeBps/);
        });

        it('rejects non-integer / out-of-range bps', function () {
            assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: CREATOR, bps: 1.5 }] }), /bps must be an integer/);
            assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to: CREATOR, bps: 0 }] }), /bps must be an integer/);
        });

        it('rejects a royalty leg address the chain cannot decode', function () {
            const bad = ['1Creator', 'C:BTC:123', '', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb',
                         '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNL7', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5'];
            for (const to of bad) {
                assert.throws(() => validateConfig({ gates: ['trade'], royalty: [{ to, bps: 100 }] }),
                    /royalty leg "to"/, 'accepted an undecodable leg address: ' + JSON.stringify(to));
            }
        });

        it('accepts real base58check and bech32 leg addresses on any network', function () {
            const good = ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
                          '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
                          'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
                          'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L',
                          'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
                          'bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y'];
            for (const to of good) {
                const cfg = validateConfig({ gates: ['trade'], royalty: [{ to, bps: 100 }] });
                assert.strictEqual(cfg.royalty[0].to, to);
            }
        });

        it('the leg-address rule does NOT reach owner, freeze or allowlist entries', function () {
            const cfg = validateConfig({ gates: ['transfer'], owner: 'C:BTC:123', freeze: ['1Frozen'], allowlist: ['1Good'] });
            assert.strictEqual(cfg.owner, 'C:BTC:123');
        });

        it('rejects an injection-shaped address', function () {
            assert.throws(() => validateConfig({ gates: ['transfer'], owner: "1x'; hack()//" }), /owner must be a valid address/);
            assert.throws(() => validateConfig({ gates: ['transfer'], owner: OWNER, freeze: ["1a\nb"] }), /freeze address/);
        });

        it('rejects a non-integer maxTakeBps', function () {
            assert.throws(() => validateConfig({ gates: ['trade'], maxTakeBps: 99999, royalty: [{ to: CREATOR, bps: 1 }] }), /maxTakeBps must be an integer/);
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
};
