// SPDX-License-Identifier: MIT

'use strict';

module.exports = function registerMetadataIdentity(deps) {
    const {
        assert, generatePolicy, loadContract, mockXchain,
        POLICY_EXAMPLE, OWNER, MATRIX
    } = deps;

    describe('policy-gen: contract identity (meta)', function () {
        it('the shipped example has explicit meta first and generates successfully', function () {
            assert.strictEqual(Object.keys(POLICY_EXAMPLE)[0], 'meta');
            const c = loadContract(generatePolicy(POLICY_EXAMPLE).source);
            assert.deepStrictEqual(c.meta, POLICY_EXAMPLE.meta);
            const init = mockXchain({ source: POLICY_EXAMPLE.owner });
            c.initialize(init);
            assert.deepStrictEqual(c.guard(mockXchain({
                state: Object.fromEntries(init._state),
                inputs: ['ORDER_CREATE', POLICY_EXAMPLE.allowlist[0], '1Buyer']
            })), {
                payoutLegs: [
                    { to: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', bps: 250 },
                    { to: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', bps: 100 }
                ]
            });
        });

        it('a config with no meta block receives generated defaults', function () {
            const config = { name: 'DefaultIdentity', owner: OWNER, gates: ['transfer'], pausable: true };
            assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'meta'), false);
            const c = loadContract(generatePolicy(config).source);
            assert.strictEqual(Object.keys(c)[0], 'meta');
            assert.deepStrictEqual(c.meta, {
                name: 'DefaultIdentity',
                description: 'Generated controller guard for the transfer action class, enforcing an owner pause switch.',
                version: '1.0.0'
            });
        });

        it('every matrix variant emits meta as the FIRST exported key, fully populated', function () {
            for (const key of Object.keys(MATRIX)) {
                const c = loadContract(generatePolicy(MATRIX[key]).source);
                assert.strictEqual(Object.keys(c)[0], 'meta', key + ' does not emit meta first');
                assert.ok(c.meta && typeof c.meta === 'object' && !Array.isArray(c.meta), key + ' meta is not a plain object');
                assert.ok(typeof c.meta.name === 'string' && c.meta.name.length > 0, key + ' has no meta.name');
                assert.ok(typeof c.meta.description === 'string' && c.meta.description.length > 0, key + ' has no meta.description');
                assert.strictEqual(c.meta.version, '1.0.0', key + ' does not default meta.version');
                assert.ok(Buffer.byteLength(c.meta.name) <= 64, key + ' meta.name exceeds 64 bytes');
                assert.ok(Buffer.byteLength(c.meta.description) <= 512, key + ' meta.description exceeds 512 bytes');
            }
        });

        it('the default name is the config name and the default description names the gates and the rules', function () {
            const c = loadContract(generatePolicy(MATRIX.full).source);
            assert.strictEqual(c.meta.name, 'Full');
            assert.strictEqual(c.meta.description,
                'Generated controller guard for the transfer/trade action classes, enforcing an owner ' +
                'pause switch, a per-account freeze list, a from-side allowlist and a royalty split on ' +
                'trade-class actions.');
            const pause = loadContract(generatePolicy(MATRIX.pauseOnly).source);
            assert.strictEqual(pause.meta.description,
                'Generated controller guard for the transfer action class, enforcing an owner pause switch.');
            assert.strictEqual(pause.meta.description.indexOf('allowlist'), -1,
                'a pause-only guard describes an allowlist it does not have');
            assert.ok(loadContract(generatePolicy(MATRIX.allowBoth).source).meta.description
                .indexOf('a both-side allowlist') !== -1, 'the description hides the allowlist direction');
        });

        it('a caller-supplied meta wins, field by field, over the generated defaults', function () {
            const cfg = Object.assign({}, MATRIX.full, {
                meta: { name: 'Acme Transfer Policy', description: 'Acme internal transfer rules.', version: '3.2.1' }
            });
            const c = loadContract(generatePolicy(cfg).source);
            assert.strictEqual(c.meta.name, 'Acme Transfer Policy');
            assert.strictEqual(c.meta.description, 'Acme internal transfer rules.');
            assert.strictEqual(c.meta.version, '3.2.1');

            const partial = loadContract(generatePolicy(Object.assign({}, MATRIX.full, { meta: { version: '2.0.0' } })).source);
            assert.strictEqual(partial.meta.version, '2.0.0');
            assert.strictEqual(partial.meta.name, 'Full');
            assert.ok(partial.meta.description.indexOf('Generated controller guard') === 0,
                'a version-only meta suppressed the generated description');
        });

        it('rejects a meta that consensus would reject, rather than emitting an undeployable guard', function () {
            const withMeta = (meta) => Object.assign({}, MATRIX.full, { meta });
            assert.throws(() => generatePolicy(withMeta('Acme')), /meta must be an object/);
            assert.throws(() => generatePolicy(withMeta({ name: '' })), /meta\.name must be 1 to 64/);
            assert.throws(() => generatePolicy(withMeta({ name: ' Acme' })), /leading or trailing space/);
            assert.throws(() => generatePolicy(withMeta({ name: 'Acme ' })), /leading or trailing space/);
            assert.throws(() => generatePolicy(withMeta({ name: 'A\u0000cme' })), /meta\.name must be 1 to 64/);
            assert.throws(() => generatePolicy(withMeta({ name: 'Café' })), /printable ASCII/);
            assert.throws(() => generatePolicy(withMeta({ name: 'A'.repeat(65) })), /meta\.name must be 1 to 64/);
            assert.throws(() => generatePolicy(withMeta({ description: 'x'.repeat(513) })), /meta\.description must be 1 to 512/);
            assert.throws(() => generatePolicy(withMeta({ version: 'v'.repeat(33) })), /meta\.version must be 1 to 32/);
            assert.throws(() => generatePolicy(withMeta({ name: 42 })), /meta\.name must be 1 to 64/);
        });

        it('a name whose edge spaces the header tolerates is trimmed for meta, not rejected', function () {
            const c = loadContract(generatePolicy(Object.assign({}, MATRIX.full, { name: ' Spaced ' })).source);
            assert.strictEqual(c.meta.name, 'Spaced');
        });
    });
};
