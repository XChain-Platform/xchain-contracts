// SPDX-License-Identifier: MIT

'use strict';

module.exports = function registerBindHints(deps) {
    const { assert, generatePolicy, MATRIX } = deps;

    describe('policy-gen: bind hints', function () {
        it('emits an ISSUE v6 line per gated class', function () {
            const gen = generatePolicy(MATRIX.full);
            for (const g of ['transfer', 'trade']) {
                assert.ok(gen.bindHints.indexOf('ACTION_CLASS=' + g) !== -1, 'missing bind hint for ' + g);
            }
            assert.ok(gen.bindHints.indexOf('VERSION=6') !== -1);
        });

        it('scopes the account-bind alternative to transfer and names what it drops', function () {
            const hints = key => generatePolicy(MATRIX[key]).bindHints;
            for (const key of Object.keys(MATRIX)) {
                assert.ok(hints(key).indexOf('use ADDRESS v1 / sdk.controller.bindAddress.') === -1, key + ' keeps the unscoped account hint');
                assert.ok(hints(key).indexOf('runs an account guard for `transfer` ONLY') !== -1, key + ' lacks the account scope');
            }
            assert.ok(hints('full').indexOf('will NOT enforce trade;') !== -1);
            assert.ok(hints('full').indexOf('never yields a royalty split') !== -1);
            assert.ok(hints('freezeOnly').indexOf('will NOT enforce trade;') !== -1);
            assert.ok(hints('royaltyOnly').indexOf('enforces nothing') !== -1);
            assert.ok(hints('royaltyOnly').indexOf('never yields a royalty split') !== -1);
            assert.ok(hints('allowOnly').indexOf('`all` binding on an account fires for transfer only') !== -1);
            for (const warn of ['will NOT enforce', 'never yields a royalty split', 'enforces nothing', '`all` binding'])
                assert.ok(hints('pauseOnly').indexOf(warn) === -1, 'pauseOnly wrongly warns: ' + warn);
        });

        it('names the custody address allowlist requirement for every direction', function () {
            const note = 'From the CONTROLLER_CUSTODY_GUARD flag day, a contract\'s custody address ' +
                'C:<CHAIN>:<index> is the recipient of a DEPOSIT and the sender of a WITHDRAW; ' +
                'allowlist it for the token to enter or leave that contract.';
            for (const direction of ['from', 'to', 'both']) {
                const gen = generatePolicy(Object.assign({}, MATRIX.allowOnly, { allowlistDirection: direction }));
                assert.ok(gen.source.indexOf('// ' + note) !== -1, direction + ' source lacks custody note');
                assert.ok(gen.bindHints.indexOf('    ' + note) !== -1, direction + ' hints lack custody note');
            }
        });
    });
};
